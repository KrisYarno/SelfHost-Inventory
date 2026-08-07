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
 * Scope: `approvalStatus: APPROVED` ALWAYS, plus `deletedAt: null` unless the caller
 * passes `allowArchived` — the same visibility rule the find_product / operations /
 * valuation reads apply, with the historical-tool relaxation spec C13 defines.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";

/**
 * Resolve an APPROVED product by ID. Returns `{ id, name, lifecycle }` or `null`
 * (pending-review, out-of-scope, or absent). Never throws for a missing ID.
 *
 * `allowArchived` relaxes ONLY `deletedAt`; `approvalStatus: "APPROVED"` is
 * unconditional (contract pack T3). The HISTORICAL tools pass it — an archived
 * product's past really happened and their answers tag it `lifecycle: "deleted"` — while
 * the CURRENT-STATE tools leave it false and keep returning `notFound`, because there is
 * no honest "current stock" for a product that has been deleted (spec C13).
 */
export async function resolveAssistantProduct(
  productId: number,
  opts: { allowArchived?: boolean } = {},
): Promise<ResolvedAssistantProduct | null> {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      approvalStatus: "APPROVED",
      ...(opts.allowArchived ? {} : { deletedAt: null }),
    },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    lifecycle: product.deletedAt != null ? "deleted" : "active",
  };
}

/** Why a requested id produced no resolved product (contract pack T3).
 *
 *  PRIVACY-PRESERVING BY CONSTRUCTION: `unknown_id` covers BOTH "no such product" and
 *  "exists but is not APPROVED" — the two are INDISTINGUISHABLE on this surface, so a
 *  caller can never probe the approval queue by watching which ids answer differently.
 *  `not_visible` is returned ONLY for an APPROVED-but-archived product when the caller
 *  did not ask for archived ones (a visibility choice the caller itself made, so it
 *  leaks nothing). With `allowArchived: true` it is unreachable.
 */
export type ResolveRejectReason = "unknown_id" | "not_visible";

export interface ResolvedAssistantProduct {
  id: number;
  name: string;
  lifecycle: "active" | "deleted";
}

export interface ResolveAssistantProductsResult {
  resolved: ResolvedAssistantProduct[];
  rejected: Array<{ productId: number; reason: ResolveRejectReason }>;
}

/**
 * BATCH product resolution for the bounded-set tools (spec C10/C11, contract pack T3).
 *
 * Ids that fail resolution are NEVER queried downstream — a raw `{ in: [...] }` over
 * caller input would leak an unapproved product's history the moment someone guessed
 * its id. They come back as `rejected` rows instead, so the tool can echo exactly what
 * it could not answer.
 *
 * ARCHIVED-CAPABLE FROM BIRTH: `allowArchived` relaxes ONLY `deletedAt`; the
 * `approvalStatus: "APPROVED"` filter is unconditional. Historical tools pass true (an
 * archived product's past is real history); current-state tools leave it false.
 *
 * Input is deduped and `resolved` follows the input order of first occurrence, so a
 * caller's row order is predictable. Never throws for an unknown id.
 */
export async function resolveAssistantProducts(
  productIds: number[],
  opts: { allowArchived?: boolean } = {},
): Promise<ResolveAssistantProductsResult> {
  const uniq = Array.from(new Set(productIds));
  if (uniq.length === 0) return { resolved: [], rejected: [] };

  // ONE read over the APPROVED universe regardless of lifecycle: the archived/active
  // split is decided below, so an archived product can be REJECTED by name-free reason
  // without a second query.
  const rows = await prisma.product.findMany({
    where: { id: { in: uniq }, approvalStatus: "APPROVED" },
    select: { id: true, name: true, deletedAt: true },
  });
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));

  const resolved: ResolvedAssistantProduct[] = [];
  const rejected: Array<{ productId: number; reason: ResolveRejectReason }> = [];
  for (const productId of uniq) {
    const row = byId.get(productId);
    if (!row) {
      // Absent OR unapproved — deliberately the same answer (see ResolveRejectReason).
      rejected.push({ productId, reason: "unknown_id" });
      continue;
    }
    if (row.deletedAt != null && !opts.allowArchived) {
      rejected.push({ productId, reason: "not_visible" });
      continue;
    }
    resolved.push({
      id: row.id,
      name: row.name,
      lifecycle: row.deletedAt != null ? "deleted" : "active",
    });
  }
  return { resolved, rejected };
}
