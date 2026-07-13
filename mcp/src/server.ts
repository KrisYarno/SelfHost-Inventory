/**
 * mcp/src/server.ts — the read-only MCP sidecar HTTP server (spec D8, §11).
 *
 * A tiny Node http server exposing the shared curated read tools over MCP
 * Streamable HTTP, STATELESS (each request self-contained — a fresh McpServer +
 * transport per request, sessionIdGenerator: undefined). It imports ONLY the
 * framework-neutral lib/assistant modules + the Prisma client; it must NEVER reach
 * next/* or lib/api-utils (the same Next-free line the trunk gate enforces on the
 * shared modules).
 *
 *   POST /mcp     Bearer-authenticated MCP endpoint (JSON response mode).
 *   GET  /healthz Unauthenticated readiness probe (encryptionKey + db).
 *
 * Auth (auth.ts), rate limiting (rate-limit.ts), and health (health.ts) are the
 * sidecar's own concerns; tool execution, per-call 32KB budget, and telemetry are
 * closure-bound inside the trunk-owned registerMcpTools adapter.
 *
 * Disabled mode: if ENABLE_MCP !== '1', start() logs one line and returns null; the
 * process bootstrap exits 0 cleanly.
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import prisma from "@/lib/prisma";
import { registerMcpTools } from "@/lib/assistant/tool-adapters";
import { resolveToolContext } from "@/lib/assistant/context";
import { recordAssistantRun } from "@/lib/assistant/telemetry";
import { encryptionKeyReadiness } from "@/lib/assistant/readiness";
import { authenticateToken, type AuthenticatedToken } from "./auth";
import { RateLimiter, toolCallWeight } from "./rate-limit";
import { healthReport } from "./health";

const SERVER_NAME = "inventory-mcp";
const SERVER_VERSION = "0.1.0";
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_PORT = 8080;

export function isEnabled(): boolean {
  return process.env.ENABLE_MCP === "1";
}

export function mcpPort(): number {
  const parsed = Number(process.env.MCP_PORT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const bodyText = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(bodyText);
}

/** Generic 401 — no detail on WHY (malformed / unknown / revoked / dead owner all
 *  look identical to a caller). */
function unauthorized(res: http.ServerResponse): void {
  res.setHeader("WWW-Authenticate", "Bearer");
  writeJson(res, 401, { error: "unauthorized" });
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Build the per-request tool context from the authenticated token's owner. */
function makeContextFactory(token: AuthenticatedToken) {
  return () =>
    resolveToolContext(
      { id: token.ownerUserId, isAdmin: token.isAdmin },
      "mcp",
      token.tokenId,
    );
}

async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limiter: RateLimiter,
): Promise<void> {
  const auth = await authenticateToken(req.headers.authorization);
  if (!auth.ok) {
    unauthorized(res);
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  // Rate limit only on tool-calls (weighted); handshake/list/notifications are free.
  const weight = toolCallWeight(body);
  if (weight > 0) {
    const decision = limiter.consume(auth.token.tokenId, weight);
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      writeJson(res, 429, { error: "rate_limited" });
      return;
    }
  }

  // Stateless: a fresh server + transport per request (sessionIdGenerator undefined).
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerMcpTools(mcp, makeContextFactory(auth.token), recordAssistantRun);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleHealth(res: http.ServerResponse): Promise<void> {
  const report = await healthReport(prisma);
  writeJson(res, report.ok ? 200 : 503, report);
}

/** Create the sidecar's http.Server. The RateLimiter is injectable for tests. */
export function createMcpHttpServer(opts: { rateLimiter?: RateLimiter } = {}): http.Server {
  const limiter = opts.rateLimiter ?? new RateLimiter();
  return http.createServer((req, res) => {
    void route(req, res, limiter).catch((err) => {
      console.error("[mcp] unhandled request error", err);
      if (!res.headersSent) writeJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
}

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limiter: RateLimiter,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === HEALTH_PATH) {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleHealth(res);
    return;
  }

  if (url.pathname === MCP_PATH) {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleMcp(req, res, limiter);
    return;
  }

  writeJson(res, 404, { error: "not_found" });
}

/**
 * Start the sidecar. Returns the listening server, or null when disabled
 * (ENABLE_MCP !== '1') — the caller/bootstrap exits 0 in that case. Never calls
 * process.exit itself, so it is safe to call from tests.
 */
export async function start(): Promise<http.Server | null> {
  if (!isEnabled()) {
    console.log("[mcp] ENABLE_MCP is not '1' — read-only sidecar disabled, exiting cleanly");
    return null;
  }

  const key = encryptionKeyReadiness();
  if (!key.ok) {
    console.warn(
      `[mcp] ENCRYPTION_KEY not ready: ${key.reason}. Reads are unaffected; ` +
        "provider-credential decryption would fail if it were needed.",
    );
  } else {
    console.log("[mcp] ENCRYPTION_KEY present and well-formed");
  }

  const port = mcpPort();
  const server = createMcpHttpServer();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(
    `[mcp] read-only sidecar listening on port ${port} (MCP: POST ${MCP_PATH}, health: GET ${HEALTH_PATH})`,
  );
  return server;
}

// Bootstrap: auto-start when this bundle is run as the process entry
// (node dist/server.js). Jest sets NODE_ENV=test and imports this module for
// assertions only — it must never start a server or exit the runner there.
if (process.env.NODE_ENV !== "test") {
  void start().then((server) => {
    if (!server) process.exit(0);
  });
}
