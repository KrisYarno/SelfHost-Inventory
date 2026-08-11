/**
 * launch-gate/matrix-mcp.test.ts — ASSERTION MATRIX ROW 3: the MCP member-token
 * matrix (plan Task 1.8; spec C7 row 3).
 *
 * THE CLAIM: the sidecar is a SECOND door onto the same trust boundary. It resolves
 * its caller through the same `resolveToolContext` the chat route uses
 * (mcp/src/server.ts:94-102), so the same seed must produce the same two different
 * answers for the same tool — and a caller who never authenticated must learn
 * nothing at all from the refusal.
 *
 * Four things are proven here that no unit test can prove:
 *  - SCOPING is real over the wire: one tool, two tokens, two answers, each
 *    recomputed from raw SQL, with the banded company-B sentinel scanned over the
 *    whole response body (and a POSITIVE CONTROL on the admin body, so the negative
 *    scan is not vacuous).
 *  - A REVOKED token is indistinguishable from a malformed one: 401, the generic
 *    body byte-for-byte, and the `WWW-Authenticate` challenge — no oracle.
 *  - `lastUsedAt` really advances on a READ. The write is FIRE-AND-FORGET
 *    (auth.ts: `void prisma.apiToken.update(...)`), so it is POLLED, never read once.
 *    It is also the ONE sanctioned delta in the row-6 checksum manifest, which makes
 *    it the one column here that is allowed to move.
 *  - MCP run rows carry `requestId` NULL BY CONSTRUCTION (contract pack T5): the
 *    sidecar has no request envelope to attribute a tool call to. The positive
 *    control is local and in this file — the SAME tool, called through the chat
 *    route, writes a run row that DOES carry its parent request id.
 *
 * NO CHOREOGRAPHY IS INVOLVED in the MCP calls: `tools/call` runs the tool directly,
 * with no model in the loop. The one scripted turn here is the chat-side control.
 */

import { describe, expect, it, beforeAll } from "@jest/globals";
import { gatePrompt } from "./choreography";
import { MCP_BASE_URL, loginOnce, mcpCall, postTurn, type McpResponse } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_SEED } from "./seed";
import { relativeWindow, settleTurn, sleep } from "./assertions";

const MEMBER_A = GATE_SEED.actors.memberA;
const ADMIN = GATE_SEED.actors.admin;
const TOKENS = GATE_SEED.apiTokens;

/** The one company-scoped tool this row drives through BOTH tokens. Its input is the
 *  addressing scheme for the SQL recomputation below, so it lives in one place. */
const SALES_ARGS = { groupBy: "company", relativeDays: 60 } as const;

/** The generic MCP auth refusal, byte for byte (mcp/src/server.ts `unauthorized`). */
const UNAUTHORIZED_BODY = '{"error":"unauthorized"}';

type SalesRow = { companyId: string; name: string | null; _sum: { orderedQty: number } };

type ToolEnvelope =
  | { status: "ok"; data: Record<string, unknown>; meta: { scope: string; bytes: number } }
  | { status: "error"; code: "TOOL_ERROR"; hint?: string; meta: { scope: string } };

/** Unwrap `{ jsonrpc, id, result: { content: [{ type: "text", text }] } }` into the
 *  ToolResult envelope the trunk adapter serialized (tool-adapters.ts:140). */
function toolEnvelope(response: McpResponse): ToolEnvelope {
  if (response.status !== 200) {
    throw new Error(`MCP call failed with ${response.status}: ${response.raw.slice(0, 800)}`);
  }
  const rpc = response.json as {
    error?: unknown;
    result?: { content?: Array<{ type: string; text: string }> };
  };
  if (rpc?.error !== undefined) {
    throw new Error(`MCP call returned a JSON-RPC error: ${JSON.stringify(rpc.error)}`);
  }
  const text = rpc?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`MCP call returned no text content: ${response.raw.slice(0, 800)}`);
  }
  return JSON.parse(text) as ToolEnvelope;
}

function okData(response: McpResponse): Record<string, unknown> {
  const envelope = toolEnvelope(response);
  if (envelope.status !== "ok") {
    throw new Error(`expected an ok MCP tool result, got ${JSON.stringify(envelope).slice(0, 800)}`);
  }
  return envelope.data;
}

/**
 * The oracle: SUM(orderedQty) per company over the window, approved products only —
 * recomputed with raw SQL exactly as matrix-scoping does for the chat surface. Kept
 * local rather than shared: the whole value of an oracle is that each row recomputes
 * independently, and a shared helper is one place for one mistake to reach two rows.
 */
async function salesUnitsByCompany(
  companyIds: readonly string[],
  window: { from: string; to: string },
): Promise<Map<string, number>> {
  if (companyIds.length === 0) return new Map();
  const placeholders = companyIds.map(() => "?").join(", ");
  const rows = await oracleQuery<{ companyId: string; units: number }>(
    `SELECT f.companyId, SUM(f.orderedQty) AS units FROM product_sales_facts f
       JOIN products p ON p.id = f.productId
      WHERE f.companyId IN (${placeholders})
        AND f.dayKey >= ? AND f.dayKey <= ?
        AND p.approvalStatus = 'APPROVED'
      GROUP BY f.companyId`,
    [...companyIds, window.from, window.to],
  );
  return new Map(rows.map((row) => [row.companyId, Number(row.units)]));
}

async function lastUsedAtOf(tokenId: string): Promise<string | null> {
  const rows = await oracleQuery<{ lastUsedAt: string | null }>(
    "SELECT lastUsedAt FROM api_tokens WHERE id = ?",
    [tokenId],
  );
  if (rows.length !== 1) throw new Error(`api_tokens row ${tokenId} not found`);
  return rows[0].lastUsedAt === null ? null : String(rows[0].lastUsedAt);
}

/**
 * BOUNDED poll for the fire-and-forget `lastUsedAt` write. The sidecar answers the
 * tool call without awaiting that UPDATE, so reading the column the instant the
 * response lands is a race by design — the same class of race the settle barrier
 * solves for the chat route. Never a fixed sleep.
 */
async function pollLastUsedAt(
  tokenId: string,
  isAdvanced: (value: string | null) => boolean,
  deadlineMs = 10_000,
): Promise<string | null> {
  const until = Date.now() + deadlineMs;
  let last: string | null = null;
  for (;;) {
    last = await lastUsedAtOf(tokenId);
    if (isAdvanced(last)) return last;
    if (Date.now() > until) {
      throw new Error(
        `api_tokens.lastUsedAt for ${tokenId} never advanced within ${deadlineMs}ms (last seen ${String(last)})`,
      );
    }
    await sleep(100);
  }
}

type RunRow = {
  id: number;
  surface: string;
  toolName: string;
  tokenId: string | null;
  userId: number | null;
  requestId: number | null;
  outcome: string;
};

const RUN_COLUMNS = "id, surface, toolName, tokenId, userId, requestId, outcome";

/**
 * BOUNDED poll for telemetry rows. `recordAssistantRun` is deliberately best-effort
 * and is dispatched with `void onRun(...)` (tool-adapters.ts:153) — the INSERT is not
 * awaited before the response is written, so "the call answered" and "its run row
 * exists" are two different instants, exactly like the chat route's settle barrier.
 */
async function pollRuns(sql: string, params: unknown[], expected: number): Promise<RunRow[]> {
  const until = Date.now() + 10_000;
  let rows: RunRow[] = [];
  for (;;) {
    rows = await oracleQuery<RunRow>(sql, params);
    if (rows.length >= expected) return rows;
    if (Date.now() > until) {
      throw new Error(
        `expected ${expected} assistant_runs rows within 10000ms, saw ${rows.length}: ` +
          JSON.stringify(rows),
      );
    }
    await sleep(100);
  }
}

/**
 * A raw POST to the sidecar, used ONLY where the response HEADERS are part of the
 * contract. `driver.mcpCall` deliberately returns body-and-status; the generic-401
 * case is the one place the challenge header itself is the assertion.
 */
async function rawMcpPost(
  token: string,
  body: unknown,
): Promise<{ status: number; body: string; wwwAuthenticate: string | null }> {
  const response = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.text(),
    wwwAuthenticate: response.headers.get("www-authenticate"),
  };
}

describe("MATRIX ROW 3 — the MCP member-token matrix", () => {
  let memberSales: McpResponse;
  let adminSales: McpResponse;
  let misuse: McpResponse;
  let revoked: { status: number; body: string; wwwAuthenticate: string | null };
  let revokedViaDriver: McpResponse;
  let memberLastUsedBefore: string | null;
  let memberLastUsedAfter: string | null;
  let revokedLastUsedAfter: string | null;
  let runIdWatermark: number;
  let chatRequestId: number;
  let chatThreadId: string;

  beforeAll(async () => {
    const startedAt = Date.now();

    // BEFORE any call of this file: the watermark that separates THIS row's telemetry
    // rows from every other file's (jest file order varies — pack REV-8).
    const [{ maxId }] = await oracleQuery<{ maxId: number }>(
      "SELECT COALESCE(MAX(id), 0) AS maxId FROM assistant_runs",
    );
    runIdWatermark = Number(maxId);
    memberLastUsedBefore = await lastUsedAtOf(TOKENS.memberA.id);

    memberSales = await mcpCall(TOKENS.memberA.plaintext, "tools/call", {
      name: "get_sales",
      arguments: SALES_ARGS,
    });
    adminSales = await mcpCall(TOKENS.admin.plaintext, "tools/call", {
      name: "get_sales",
      arguments: SALES_ARGS,
    });
    // G1 misuse: a request the ZOD schema accepts and the POST-PARSE assert rejects
    // (house rule — cross-field rules are assert* helpers, never `.refine`, because
    // the MCP adapter reads `.shape`). This is the path that only exists on this
    // surface, so row 2l's chat-side proof does not cover it.
    misuse = await mcpCall(TOKENS.memberA.plaintext, "tools/call", {
      name: "get_sales",
      arguments: { groupBy: "day", relativeDays: 30, includeZeroRows: true },
    });

    revoked = await rawMcpPost(TOKENS.revoked.plaintext, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_sales", arguments: SALES_ARGS },
    });
    revokedViaDriver = await mcpCall(TOKENS.revoked.plaintext, "tools/call", {
      name: "get_inventory_summary",
      arguments: {},
    });

    memberLastUsedAfter = await pollLastUsedAt(
      TOKENS.memberA.id,
      (value) => value !== null && (memberLastUsedBefore === null || value > memberLastUsedBefore),
    );
    // The refused caller left NO trace: read once, after the successful token's write
    // has already been observed (so this is not merely reading too early).
    revokedLastUsedAfter = await lastUsedAtOf(TOKENS.revoked.id);

    // THE POSITIVE CONTROL for requestId: the same tool, through the CHAT route.
    const session = await loginOnce("memberA");
    const turn = await postTurn(session, {
      threadId: null,
      message: {
        id: "gate-mcp-parity-user",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("mcp-parity") }],
      },
      trigger: "submit-message",
    });
    if (turn.status !== 200 || turn.threadId === null) {
      throw new Error(`row-3 chat parity turn failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`);
    }
    chatThreadId = turn.threadId;
    await settleTurn(chatThreadId, { label: "the row-3 chat parity turn" });
    const [request] = await oracleQuery<{ id: number }>(
      "SELECT id FROM assistant_requests WHERE threadId = ? AND kind = 'chat'",
      [chatThreadId],
    );
    chatRequestId = Number(request.id);

    console.log(`[launch-gate] row 3: MCP matrix driven in ${Date.now() - startedAt}ms`);
  });

  describe("the scoping subset: one tool, two tokens, two answers", () => {
    it("memberA's token sees ONLY its own companies, recomputed from raw SQL", async () => {
      const rows = okData(memberSales).rows as SalesRow[];
      for (const row of rows) expect(MEMBER_A.companyIds).toContain(row.companyId);
      expect(new Map(rows.map((row) => [row.companyId, row._sum.orderedQty]))).toEqual(
        await salesUnitsByCompany(MEMBER_A.companyIds, relativeWindow(60)),
      );
      // The no-sales company memberA holds contributes no ROW (it has no facts) — the
      // same truth the chat surface tells in row 1.
      expect(rows.map((row) => row.companyId)).not.toContain(GATE_SEED.companies.noSales);
    });

    it("admin's token sees exactly A + B, recomputed from raw SQL", async () => {
      const rows = okData(adminSales).rows as SalesRow[];
      expect(new Map(rows.map((row) => [row.companyId, row._sum.orderedQty]))).toEqual(
        await salesUnitsByCompany(ADMIN.companyIds, relativeWindow(60)),
      );
      expect(rows.map((row) => row.companyId).sort()).toEqual([...ADMIN.companyIds].sort());
    });

    it("the two answers genuinely DIFFER (the scope is doing work)", () => {
      const memberRows = okData(memberSales).rows as SalesRow[];
      const adminRows = okData(adminSales).rows as SalesRow[];
      const units = (rows: SalesRow[]): number =>
        rows.reduce((sum, row) => sum + row._sum.orderedQty, 0);
      expect(units(adminRows)).toBeGreaterThan(units(memberRows));
      expect(adminRows.map((row) => row.companyId)).not.toEqual(
        memberRows.map((row) => row.companyId),
      );
      expect(toolEnvelope(memberSales)).toMatchObject({ meta: { scope: "company" } });
    });

    it("ZERO company-B sentinel bytes reach memberA's token — with a positive control", () => {
      for (const sentinel of GATE_SEED.sentinels.companyB) {
        const at = memberSales.raw.indexOf(sentinel);
        if (at !== -1) {
          throw new Error(
            `COMPANY-B SENTINEL LEAK over MCP: "${sentinel}" at byte ${at} of memberA's response — ` +
              `context: ${JSON.stringify(memberSales.raw.slice(Math.max(0, at - 160), at + 160))}`,
          );
        }
      }
      // Without this the scan above would pass on a sidecar that returned nothing.
      expect(adminSales.raw).toContain(GATE_SEED.sentinels.companyB[0]);
    });
  });

  describe("a REVOKED token is a generic auth failure", () => {
    it("answers 401 with the generic body, byte for byte, and a Bearer challenge", () => {
      expect(revoked.status).toBe(401);
      expect(revoked.body).toBe(UNAUTHORIZED_BODY);
      expect(revoked.wwwAuthenticate).toBe("Bearer");
      // No detail on WHY: nothing names the token, the owner, or revocation.
      expect(revoked.body).not.toContain("revok");
      expect(revoked.body).not.toContain(TOKENS.revoked.id);
    });

    it("refuses every tool the same way (the refusal is pre-dispatch)", () => {
      expect(revokedViaDriver.status).toBe(401);
      expect(revokedViaDriver.raw).toBe(UNAUTHORIZED_BODY);
    });

    it("is the same 401 an UNKNOWN well-formed token gets (no existence oracle)", async () => {
      const unknown = await rawMcpPost(`invmcp_${"z".repeat(43)}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_inventory_summary", arguments: {} },
      });
      expect({ status: unknown.status, body: unknown.body, challenge: unknown.wwwAuthenticate }).toEqual({
        status: revoked.status,
        body: revoked.body,
        challenge: revoked.wwwAuthenticate,
      });
    });

    it("writes NO telemetry row and never touches its own lastUsedAt", async () => {
      expect(revokedLastUsedAfter).toBeNull();
      const [{ n }] = await oracleQuery<{ n: number }>(
        "SELECT COUNT(*) AS n FROM assistant_runs WHERE tokenId = ?",
        [TOKENS.revoked.id],
      );
      expect(Number(n)).toBe(0);
    });
  });

  describe("lastUsedAt advances on a READ (polled — the write is fire-and-forget)", () => {
    it("moved forward for the token that authenticated", () => {
      expect(memberLastUsedAfter).not.toBeNull();
      if (memberLastUsedBefore !== null) {
        expect(String(memberLastUsedAfter) > memberLastUsedBefore).toBe(true);
      }
    });

    it("is the ONLY api_tokens column the gate lets move (row 6's exemption)", async () => {
      // Positive statement of the exemption's scope: everything else on the row is
      // byte-identical to the seed, so the D8 bracket's column exclusion cannot
      // quietly cover a second column.
      const [row] = await oracleQuery<{
        name: string;
        tier: string;
        tokenHash: string;
        ownerUserId: number;
        revokedAt: string | null;
      }>("SELECT name, tier, tokenHash, ownerUserId, revokedAt FROM api_tokens WHERE id = ?", [
        TOKENS.memberA.id,
      ]);
      expect({
        name: row.name,
        tier: row.tier,
        ownerUserId: Number(row.ownerUserId),
        revokedAt: row.revokedAt,
      }).toEqual({
        name: "gate memberA token",
        tier: "read",
        ownerUserId: MEMBER_A.userId,
        revokedAt: null,
      });
    });
  });

  describe("MCP run rows carry requestId NULL by construction (pack T5)", () => {
    it("this row's own MCP calls wrote run rows: mcp surface, token attributed, requestId NULL", async () => {
      // Three MCP tool calls reached a tool in this file (two scoping reads plus the
      // misuse one); the revoked and unknown callers never got past authentication.
      const rows = await pollRuns(
        `SELECT ${RUN_COLUMNS} FROM assistant_runs WHERE id > ? AND surface = 'mcp' ORDER BY id`,
        [runIdWatermark],
        3,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.toolName).toBe("get_sales");
        expect(row.requestId).toBeNull();
        expect(row.tokenId).not.toBeNull();
      }
      // Order-independent: the telemetry INSERT is fire-and-forget, so the row ORDER
      // is not part of any contract — the ATTRIBUTION is.
      const byToken = rows.map((row) => ({
        tokenId: row.tokenId,
        userId: Number(row.userId),
        outcome: row.outcome,
      }));
      expect(byToken.filter((row) => row.outcome === "ok")).toHaveLength(2);
      expect(byToken.filter((row) => row.outcome === "error")).toHaveLength(1);
      expect(byToken.filter((row) => row.tokenId === TOKENS.memberA.id)).toHaveLength(2);
      expect(byToken.filter((row) => row.tokenId === TOKENS.admin.id)).toHaveLength(1);
      for (const row of byToken) {
        // The owner, never the caller-supplied anything: memberA's token attributes to
        // memberA, admin's to admin.
        expect(row.userId).toBe(
          row.tokenId === TOKENS.admin.id ? ADMIN.userId : MEMBER_A.userId,
        );
      }
    });

    it("no MCP row anywhere in the run carries a request id", async () => {
      const [{ n }] = await oracleQuery<{ n: number }>(
        "SELECT COUNT(*) AS n FROM assistant_runs WHERE surface = 'mcp' AND requestId IS NOT NULL",
      );
      expect(Number(n)).toBe(0);
    });

    it("POSITIVE CONTROL: the SAME tool through the chat route DOES carry its parent request id", async () => {
      const rows = await pollRuns(
        `SELECT ${RUN_COLUMNS} FROM assistant_runs WHERE requestId = ? ORDER BY id`,
        [chatRequestId],
        1,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].toolName).toBe("get_inventory_summary");
      expect(Number(rows[0].requestId)).toBe(chatRequestId);
      // The chat surface has no token: attribution there is the session's userId.
      expect(rows[0].tokenId).toBeNull();
    });
  });

  describe("a G1 misuse rejection surfaces its hint through the MCP adapter", () => {
    it("returns the masked TOOL_ERROR envelope with a self-correcting hint", () => {
      const envelope = toolEnvelope(misuse);
      expect(envelope.status).toBe("error");
      if (envelope.status !== "error") throw new Error("unreachable");
      expect(envelope.code).toBe("TOOL_ERROR");
      expect(envelope.hint).toContain("includeZeroRows requires groupBy:'product'");
      expect(envelope.meta.scope).toBe("company");
    });

    it("is an ordinary 200 tool result, not a transport error (the MCP client can read it)", () => {
      expect(misuse.status).toBe(200);
      const rpc = misuse.json as { error?: unknown };
      expect(rpc.error).toBeUndefined();
    });
  });
});
