/**
 * @jest-environment node
 *
 * W2 seam-fix item 7 — the documented error-MASKING contract for get_stock_asof.
 *
 * getStockAsOf THROWS an AppError(VALIDATION, 400) on a today/future/malformed dayKey
 * (snapshots cover completed days only). The AI-SDK adapter (createAiTools) must catch
 * that and surface the GENERIC `{ status:"error", code:"TOOL_ERROR", meta:{ scope } }`
 * — never the AppError's 400/message. This pins that masking so a future refactor can't
 * start leaking the raw validation error (or its status) into the model's tool result.
 */

// `ai` (v7) is ESM-only with no CJS build — jest-runtime cannot load it. The adapter's
// execute path never calls ai's tool() body (createAiTools only stores def + execute),
// so stub tool() to return its definition object verbatim (the shape execute lives on).
jest.mock("ai", () => ({ __esModule: true, tool: (def: unknown) => def }));

// The throw happens in getStockAsOf BEFORE any query (assertCompletedDay), so prisma is
// never reached — a bare stub satisfies the module import graph.
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import { createAiTools } from "@/lib/assistant/tool-adapters";
import type { ToolContext as ResolvedContext } from "@/lib/assistant/context";

const CTX: ResolvedContext = {
  userId: 1,
  tokenId: null,
  surface: "web",
  companyIds: ["c1"],
} as unknown as ResolvedContext;

type ExecTool = { execute: (args: unknown) => Promise<unknown> };

describe("createAiTools — get_stock_asof AppError is masked to a generic TOOL_ERROR (item 7)", () => {
  it("a future dayKey (module throws AppError VALIDATION/400) surfaces the generic TOOL_ERROR, not the 400", async () => {
    const runs: Array<{ outcome: string; resultBytes: number }> = [];
    const onRun = jest.fn((r: { outcome: string; resultBytes: number }) => {
      runs.push(r);
      return Promise.resolve(undefined);
    });
    const set = createAiTools(CTX, { remaining: 65_536 }, onRun as never);
    const tool = set.get_stock_asof as unknown as ExecTool;

    // 2099-01-01 is always future relative to the real clock => getStockAsOf throws.
    const result = await tool.execute({ dayKey: "2099-01-01" });

    // The generic, documented masking shape — no AppError code/message/status leaks.
    expect(result).toEqual({ status: "error", code: "TOOL_ERROR", meta: { scope: "global" } });
    // Telemetry still records the run as an error (0 result bytes).
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("error");
    expect(runs[0].resultBytes).toBe(0);
  });
});
