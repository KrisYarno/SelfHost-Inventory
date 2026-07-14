/**
 * @jest-environment node
 */

/**
 * Lane 6 T5 — THE THREE ENFORCEMENT LAYERS.
 *
 * The moment this suite is green, the codebase provably cannot reach a merchant
 * platform except through lib/platforms/egress. No W2 slice may launch until then
 * (see the plan's execution notes).
 *
 *   LAYER A — the runtime network interceptor (jest.setup.js). Proven here by the
 *             three bypass fixtures, each of which must FAIL with the sentinel.
 *   LAYER B — the import boundary: only egress may import an HTTP client or the
 *             Integration credential decryptor.
 *   LAYER C — a scoped source scan for platform-bound fetch outside egress
 *             (defense in depth, statement-normalized).
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  EGRESS_SENTINEL,
  assertInterceptorInstalled,
  isPlatformBound,
} from "@/__tests__/support/network-interceptor";

const REPO_ROOT = process.cwd();
const EGRESS_DIR = "lib/platforms/egress";

// ===========================================================================
// LAYER A — the interceptor is installed, and every bypass fails
// ===========================================================================

describe("LAYER A — the runtime interceptor", () => {
  it("is installed and non-replaceable (assertion the whole suite depends on)", () => {
    expect(() => assertInterceptorInstalled()).not.toThrow();
  });

  it("survives assignment — `global.fetch = mock` injects a delegate, it does NOT clobber the guard", () => {
    // The codex #13 concern: 22 suites do `global.fetch = jest.fn()`. That must
    // not remove the guard. After assignment the accessor is still ours.
    global.fetch = jest.fn() as unknown as typeof fetch;
    expect(() => assertInterceptorInstalled()).not.toThrow();
  });

  it("a platform bypass still fails AFTER a test injected its own fetch mock", async () => {
    // Even with a permissive mock installed, a platform-bound unmarked request is
    // caught by the guard before the delegate is ever reached.
    global.fetch = jest.fn().mockResolvedValue(new Response("{}")) as unknown as typeof fetch;
    await expect(
      fetch("https://store.example.com/wp-json/wc/v3/orders/9", { method: "PUT" })
    ).rejects.toThrow(EGRESS_SENTINEL);
  });

  it("still allows a test's fetch mock to work (injected as a delegate)", async () => {
    const mock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    // A non-platform URL is allowed through to the delegate.
    global.fetch = mock as unknown as typeof fetch;

    const res = await fetch("https://internal.app/api/thing");

    // The guard forwards with the EXACT arity it was called with (one arg here).
    expect(mock).toHaveBeenCalledWith("https://internal.app/api/thing");
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(res.status).toBe(200);
  });

  describe("every bypass fixture FAILS with the sentinel (proven, not assumed)", () => {
    it("captured-original fetch is caught", async () => {
      const { attemptBypass } = await import(
        "@/__tests__/fixtures/egress-bypass/captured-fetch-bypass"
      );
      await expect(attemptBypass()).rejects.toThrow(EGRESS_SENTINEL);
    });

    it("node:https.request is caught", async () => {
      const { attemptBypass } = await import(
        "@/__tests__/fixtures/egress-bypass/https-get-bypass"
      );
      await expect(attemptBypass()).rejects.toThrow(EGRESS_SENTINEL);
    });

    it("dynamic-import + aliased fetch is caught", async () => {
      const { attemptBypass } = await import(
        "@/__tests__/fixtures/egress-bypass/dynamic-import-bypass"
      );
      await expect(attemptBypass()).rejects.toThrow(EGRESS_SENTINEL);
    });
  });

  it("a MARKED platform request (from egress) is permitted through", async () => {
    // Simulate what http.ts does: attach the mark. This must NOT throw.
    const { EGRESS_MARK } = await import("@/lib/platforms/egress/mark");
    const mock = jest.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    global.fetch = mock as unknown as typeof fetch;

    await expect(
      fetch("https://store.example.com/wp-json/wc/v3/products/batch", {
        method: "POST",
        [EGRESS_MARK]: true,
      } as RequestInit)
    ).resolves.toBeDefined();
    expect(mock).toHaveBeenCalled();
  });

  it("isPlatformBound recognises the platform host shapes", () => {
    expect(isPlatformBound("https://x/wp-json/wc/v3/orders/1")).toBe(true);
    expect(isPlatformBound("https://y/admin/api/2025-10/orders.json")).toBe(true);
    expect(isPlatformBound("https://z.myshopify.com/anything")).toBe(true);
    expect(isPlatformBound("https://internal.app/api/inventory")).toBe(false);
  });
});

// ===========================================================================
// LAYER B — the import boundary
// ===========================================================================

/**
 * Recursively list first-party .ts/.tsx source files (excludes tests, build
 * output, node_modules, and the fixtures which bypass ON PURPOSE).
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const skip = new Set([
    "node_modules",
    ".next",
    ".git",
    "__tests__",
    "coverage",
    "mcp",
  ]);
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (skip.has(entry)) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
        out.push(full);
      }
    }
  };
  for (const top of ["lib", "app", "components", "hooks"]) {
    const p = join(dir, top);
    try {
      if (statSync(p).isDirectory()) walk(p);
    } catch {
      /* dir absent */
    }
  }
  return out;
}

function isInsideEgress(file: string): boolean {
  return relative(REPO_ROOT, file).startsWith(EGRESS_DIR);
}

describe("LAYER B — import boundary (scoped to credentials + platform origins)", () => {
  const files = sourceFiles(REPO_ROOT);

  it("finds a representative population of source files (guards a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("only egress imports an HTTP CLIENT LIBRARY (node:http/https/undici/node-fetch/axios)", () => {
    // NOTE deliberately scoped: this bans HTTP CLIENT LIBRARIES, not the global
    // `fetch` (which is legitimate for same-origin app/sidecar calls all over the
    // codebase). Platform-bound `fetch` is caught by LAYER C + LAYER A instead.
    //
    // REV-2 #17: the AI-provider test route legitimately probes AI providers
    // (Ollama/OpenAI-compatible) with the raw client and is NOT a platform path.
    // It is a REVIEWED, ENUMERATED exception — not a hole in the boundary.
    const ALLOWED_HTTP_CLIENT = new Set<string>([
      "app/api/admin/ai-providers/[kind]/test/route.ts",
    ]);

    const clientImport =
      /\bfrom\s+['"](?:node:)?(?:https?|undici|node-fetch|axios)['"]/;
    const violations: string[] = [];

    for (const file of files) {
      if (isInsideEgress(file)) continue;
      const rel = relative(REPO_ROOT, file);
      if (ALLOWED_HTTP_CLIENT.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (clientImport.test(src)) {
        violations.push(rel);
      }
    }

    expect(violations).toEqual([]);
  });

  it("only egress + the webhook signature verifier decrypt INTEGRATION CREDENTIALS", () => {
    // Scoped to Integration credential material (REV-2 #17). The AI-provider
    // layer legitimately decrypts its OWN keys and must NOT be swept up, so this
    // rule keys on the Integration credential field NAMES, not on `decryptValue`
    // in the abstract.
    const ALLOWED = new Set<string>([
      // egress owns Integration credential decryption
      join(EGRESS_DIR, "credentials.ts"),
      // the webhook route verifies signatures with a SEPARATE secret (codex #9);
      // it reads integration.webhookSecret, not the API credentials.
      "app/api/webhooks/[integrationId]/route.ts",
    ]);

    const credentialFieldTouch =
      /\bencrypted(?:Write|Read)(?:Key|Secret)\b/;
    const decrypts = /\bdecryptValue\s*\(|\bdecryptOrNull\s*\(/;

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (isInsideEgress(file)) continue;
      if (ALLOWED.has(rel)) continue;

      const src = readFileSync(file, "utf8");
      // A violation is a file that BOTH decrypts AND references an Integration
      // write/read credential field — i.e. resolves a platform credential.
      if (decrypts.test(src) && credentialFieldTouch.test(src)) {
        violations.push(rel);
      }
    }

    expect(violations).toEqual([]);
  });

  it("only egress imports the egress-private modules (mark / http / credentials)", () => {
    const privateImport =
      /\bfrom\s+['"]@\/lib\/platforms\/egress\/(?:mark|http|credentials|audit|posture)['"]/;
    const violations: string[] = [];

    for (const file of files) {
      if (isInsideEgress(file)) continue;
      const src = readFileSync(file, "utf8");
      if (privateImport.test(src)) {
        violations.push(relative(REPO_ROOT, file));
      }
    }

    expect(violations).toEqual([]);
  });
});

// ===========================================================================
// LAYER C — scoped source scan (defense in depth)
// ===========================================================================

describe("LAYER C — no platform-bound fetch outside egress", () => {
  const files = sourceFiles(REPO_ROOT);

  // Deliberately NOT a scan for `/wp-json/` PATH LITERALS. After Lane 6, callers
  // legitimately pass origin-relative platform paths to `platformRead(...)` — the
  // paths are everywhere and correct. The hazard is an OUTBOUND PRIMITIVE aimed
  // at a platform, so that is what this scans for.

  const OUTBOUND_PRIMITIVE = /\bfetch\s*\(|\.\s*(?:request|get|post|put)\s*\(/;
  const PLATFORM_MARKER = /\/wp-json\/wc\/v3\/|\/admin\/api\/|\.myshopify\.com/;

  it("no outbound primitive is aimed at a platform host outside egress (statement-normalized)", () => {
    const violations: Array<{ file: string; snippet: string }> = [];

    for (const file of files) {
      if (isInsideEgress(file)) continue;
      const src = readFileSync(file, "utf8");
      const normalized = src.replace(/\s+/g, " ");

      // Walk each outbound-primitive call and look at the ~200-char window after
      // it (multiline-safe, since whitespace is collapsed). A platform marker in
      // that window means the primitive is aimed at a store.
      const re = new RegExp(OUTBOUND_PRIMITIVE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(normalized)) !== null) {
        const window = normalized.slice(m.index, m.index + 200);
        if (PLATFORM_MARKER.test(window)) {
          violations.push({
            file: relative(REPO_ROOT, file),
            snippet: window.slice(0, 90),
          });
        }
      }
    }

    // A failure here means an outbound HTTP call to a store exists outside the
    // chokepoint. Route it through platformRead / pushStockStatus / pushOrderStatus.
    expect(violations).toEqual([]);
  });

  it("no FULL platform URL (scheme + host) is constructed outside egress", () => {
    const fullUrl = /['"`]https?:\/\/[^'"`]*(?:\/wp-json\/wc\/v3\/|\/admin\/api\/)/;
    const violations: string[] = [];
    for (const file of files) {
      if (isInsideEgress(file)) continue;
      const src = readFileSync(file, "utf8");
      if (fullUrl.test(src)) violations.push(relative(REPO_ROOT, file));
    }
    expect(violations).toEqual([]);
  });
});

// ===========================================================================
// The write surface inventory — there are exactly two write functions
// ===========================================================================

describe("the platform write surface is exactly two functions", () => {
  it("grep finds pushStockStatus / pushOrderStatus defined ONLY in egress/index.ts", () => {
    // Exact names + trailing `(` so `pushOrderStatusToExternal` (the thin wrapper
    // in shared.ts that DELEGATES here) is not mistaken for a second definition.
    const hits = execSync(
      `grep -rlnE "export async function pushStockStatus\\(|export async function pushOrderStatus\\(" lib app --include=*.ts || true`,
      { cwd: REPO_ROOT, encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(hits).toEqual(["lib/platforms/egress/index.ts"]);
  });
});
