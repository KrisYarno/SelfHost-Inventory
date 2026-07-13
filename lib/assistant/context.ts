/**
 * lib/assistant/context.ts — framework-NEUTRAL tool context (spec D4, codex #15).
 *
 * `resolveToolContext` does the prisma company-membership lookup DIRECTLY; it must
 * NOT import `@/lib/api-utils` (which drags Next server internals into the MCP
 * build). The app's routes still run their own guards (requireApproved/requireCSRF)
 * and pass the resolved user in; the MCP sidecar resolves the owner from a token.
 *
 * MUST stay Next-free — enforced by __tests__/integration/lane4-next-free-gate.test.ts.
 */

import prisma from "@/lib/prisma";

export interface ToolContext {
  userId: number;
  isAdmin: boolean;
  companyIds: string[];
  surface: "assistant" | "mcp";
  tokenId?: string;
}

/**
 * Resolve the tool-execution context for a caller. `companyIds` are the user's OWN
 * memberships (the ER-D3 ownership-view rule — never "all companies", even for
 * admins); zero memberships => [] (get_sales treats [] as hard isolation and
 * returns an empty result + note). `tokenId` is set only for the MCP surface.
 */
export async function resolveToolContext(
  user: { id: number; isAdmin: boolean },
  surface: "assistant" | "mcp",
  tokenId?: string,
): Promise<ToolContext> {
  const memberships = await prisma.userCompany.findMany({
    where: { userId: user.id },
    select: { companyId: true },
  });

  return {
    userId: user.id,
    isAdmin: user.isAdmin,
    companyIds: memberships.map((m: { companyId: string }) => m.companyId),
    surface,
    ...(tokenId ? { tokenId } : {}),
  };
}
