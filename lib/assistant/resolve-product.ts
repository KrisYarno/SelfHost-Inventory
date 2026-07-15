/**
 * lib/assistant/resolve-product.ts — the ONE assistant/MCP product resolver
 * (assistant toolsuite breadth, spec §4 W0-PROD).
 *
 * Every productId-taking tool resolves through this so a guessed pending-review or
 * soft-deleted product ID can never leak provisional stock/sales through the
 * assistant or MCP surface. A tool that gets `null` back returns the shared
 * `notFound("product", id)` error result — never a `currentStock: 0` for an ID that
 * merely isn't APPROVED.
 *
 * Scope: `deletedAt: null AND approvalStatus: APPROVED` — the same visibility rule the
 * find_product / operations / valuation reads already apply.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";

/**
 * Resolve an approved, non-deleted product by ID. Returns `{ id, name }` or `null`
 * (pending-review, soft-deleted, or absent). Never throws for a missing ID.
 */
export async function resolveAssistantProduct(
  productId: number,
): Promise<{ id: number; name: string } | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null, approvalStatus: "APPROVED" },
    select: { id: true, name: true },
  });
  return product ?? null;
}
