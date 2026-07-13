import { NextRequest, NextResponse } from "next/server";
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { decryptValue } from "@/lib/encryption";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROVIDER_KINDS = ["ANTHROPIC", "OPENAI", "GOOGLE", "OLLAMA"] as const;
type ProviderKind = (typeof PROVIDER_KINDS)[number];

const OLLAMA_TIMEOUT_MS = 3_000;
const CLOUD_TIMEOUT_MS = 5_000;
const BODY_CAP_BYTES = 64 * 1024;

function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Hardened server-side reachability probe for a self-hosted Ollama endpoint
 * (D12, codex #15): scheme restricted to http/https, userinfo rejected,
 * redirects NOT followed, 3s timeout, 64KB body cap, and DNS re-resolved at
 * connect via a `lookup` hook on a node http(s) request (NOT preflight-then-
 * fetch — that has a TOCTOU rebinding window). Returns a generic reachable
 * boolean only; never surfaces the response body, headers, or errors.
 */
function probeOllama(baseUrl: string | null): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(baseUrl ?? "");
    } catch {
      resolve({ ok: false });
      return;
    }

    // Scheme allowlist + userinfo rejection (SSRF hardening).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      resolve({ ok: false });
      return;
    }
    if (url.username || url.password) {
      resolve({ ok: false });
      return;
    }

    const transport = url.protocol === "https:" ? https : http;
    url.pathname = "/api/tags";
    url.search = "";

    let settled = false;
    const done = (ok: boolean, req?: http.ClientRequest) => {
      if (settled) return;
      settled = true;
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok });
    };

    let req: http.ClientRequest;
    try {
      req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname,
          method: "GET",
          timeout: OLLAMA_TIMEOUT_MS,
          // Re-resolve DNS at connect time (no preflight lookup): defeats the
          // resolve-then-connect rebinding window.
          lookup: dnsLookup,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // Redirects are disabled: a 3xx is treated as unreachable.
          if (status < 200 || status >= 300) {
            res.destroy();
            done(false, req);
            return;
          }
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > BODY_CAP_BYTES) {
              res.destroy();
              done(false, req);
            }
          });
          res.on("end", () => done(true, req));
          res.on("error", () => done(false, req));
        },
      );
    } catch {
      resolve({ ok: false });
      return;
    }

    req.on("timeout", () => done(false, req));
    req.on("error", () => done(false, req));
    req.end();
  });
}

/** Cloud models-list / 1-token ping using the SAVED key (the key never leaves
 *  the server). Fixed, known hosts — no SSRF surface. Generic pass/fail only. */
async function probeCloud(kind: ProviderKind, apiKey: string): Promise<{ ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
  try {
    let url: string;
    let headers: Record<string, string>;
    switch (kind) {
      case "ANTHROPIC":
        url = "https://api.anthropic.com/v1/models?limit=1";
        headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
        break;
      case "OPENAI":
        url = "https://api.openai.com/v1/models";
        headers = { Authorization: `Bearer ${apiKey}` };
        break;
      case "GOOGLE":
        url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
        headers = { "x-goog-api-key": apiKey };
        break;
      default:
        return { ok: false };
    }
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/admin/ai-providers/[kind]/test — connectivity probe. Returns a
 * generic verified/failed result ONLY. No mutation, no change-tracking (this
 * route is a coverage-gate PERMANENT_EXEMPT connectivity probe).
 */
export const POST = apiHandler(
  async (request: NextRequest, { params }: { params: { kind: string } }) => {
    await requireAdmin();
    await requireCSRF(request);

    const kindRaw = (params.kind ?? "").toUpperCase();
    if (!isProviderKind(kindRaw)) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
    }
    const kind: ProviderKind = kindRaw;

    const provider = await prisma.aiProvider.findUnique({ where: { kind } });

    let result: { ok: boolean };
    if (kind === "OLLAMA") {
      result = await probeOllama(provider?.baseUrl ?? null);
    } else if (!provider?.encryptedApiKey) {
      result = { ok: false };
    } else {
      let key: string;
      try {
        key = decryptValue(provider.encryptedApiKey);
      } catch {
        return NextResponse.json(
          { ok: false, status: "failed" },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      result = await probeCloud(kind, key);
    }

    return NextResponse.json(
      { ok: result.ok, status: result.ok ? "verified" : "failed" },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
