/**
 * lib/assistant/tool-adapters.ts — the ONLY place the AI SDK / MCP SDK see the
 * shared tools (spec D4, codex #1). Context, byte budget, and telemetry are
 * CLOSURE-BOUND here so the framework-neutral definitions in tools.ts never touch
 * a framework type.
 *
 * MUST stay Next-free (imports `ai` + the MCP SDK, never `next/*` / `lib/api-utils`).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assistantTools,
  TOOL_SCOPES,
  PER_TOOL_RESULT_CAP_BYTES,
  type ToolResult,
} from "@/lib/assistant/tools";
import type { ToolContext } from "@/lib/assistant/context";
import type { RecordRun } from "@/lib/assistant/telemetry";

const TURN_BUDGET_NOTICE =
  "The combined results for this turn are too large. Ask a narrower question.";

function errorResult(name: string): ToolResult {
  return { status: "error", code: "TOOL_ERROR", meta: { scope: TOOL_SCOPES[name] ?? "global" } };
}

/**
 * Adapt the shared tools into an AI SDK `ToolSet` bound to one request's context,
 * a MUTABLE cumulative byte budget, and the telemetry recorder. The budget object
 * is decremented across every tool call in the turn; a call that would exceed it is
 * downgraded to a truncation notice.
 */
export function createAiTools(
  ctx: ToolContext,
  budget: { remaining: number },
  onRun: RecordRun,
): ToolSet {
  const set: ToolSet = {};
  for (const [name, def] of Object.entries(assistantTools)) {
    set[name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (args: unknown) => {
        const started = Date.now();
        let result: ToolResult;
        try {
          result = await def.run(args, ctx);
        } catch {
          result = errorResult(name);
        }

        if (result.status === "ok") {
          if (result.meta.bytes > budget.remaining) {
            result = {
              status: "truncated",
              notice: TURN_BUDGET_NOTICE,
              meta: { scope: result.meta.scope, bytes: result.meta.bytes },
            };
          } else {
            budget.remaining -= result.meta.bytes;
          }
        }

        recordRun(onRun, ctx, name, result, Date.now() - started);
        return result;
      },
    });
  }
  return set;
}

/**
 * Register the shared tools on an MCP server (stateless): a FRESH context per
 * invocation and the per-tool single-result cap (list tools already paginate to
 * fit it, so this is only a last-resort guard). Read-only — no mutation tools in v1.
 */
export function registerMcpTools(
  server: McpServer,
  makeCtx: () => Promise<ToolContext>,
  onRun: RecordRun,
): void {
  for (const [name, def] of Object.entries(assistantTools)) {
    const shape = (def.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    server.registerTool(
      name,
      { description: def.description, inputSchema: shape },
      async (args: unknown) => {
        const ctx = await makeCtx();
        const started = Date.now();
        let result: ToolResult;
        try {
          result = await def.run(args, ctx);
        } catch {
          result = errorResult(name);
        }

        if (result.status === "ok" && result.meta.bytes > PER_TOOL_RESULT_CAP_BYTES) {
          result = {
            status: "truncated",
            notice: TURN_BUDGET_NOTICE,
            meta: { scope: result.meta.scope, bytes: result.meta.bytes },
          };
        }

        recordRun(onRun, ctx, name, result, Date.now() - started);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );
  }
}

function recordRun(
  onRun: RecordRun,
  ctx: ToolContext,
  toolName: string,
  result: ToolResult,
  durationMs: number,
): void {
  void onRun({
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    surface: ctx.surface,
    toolName,
    outcome: result.status,
    durationMs,
    resultBytes: result.status === "error" ? 0 : result.meta.bytes,
  });
}
