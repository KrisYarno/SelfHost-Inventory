/**
 * lib/reports/order-signal.ts — the recorded-order figures for products the reorder
 * report cannot size (A2 pack C4; Kris 2026-10-27: flag + figures, never a quantity).
 *
 * A product that is out of stock but still being ordered has no stock OUTFLOW to size a
 * reorder from, so the report files it `unavailable`. This module reads what the caller's
 * companies' order records say about it over a calendar window — ordered units and
 * orders — so the tool can flag it instead of reading as "no demand". The figures are a
 * SEPARATE fact family: never added to the stock-outflow demand, never a quantity.
 *
 * TRUTHFUL-DATA CORE:
 *  - Coverage first: a product with no fact row is a MEASURED zero only when the records
 *    cover the whole window for every one of the caller's companies (`full`). Otherwise the
 *    absence is UNKNOWN and the caller gets `reason` — get_sales' own sentence
 *    (`salesCoverageReason`), never a new paraphrase.
 *  - The coverage scope is the APPROVED-ACTIVE catalog (the reorder population), so an
 *    unapproved product's older fact can never move the start and turn an unknown into a
 *    zero.
 *  - Company-scoped: every read is narrowed to the caller's `companyIds` (empty = no read).
 *
 * MUST stay Next-free and read-only (imported by the assistant-tool layer; registered in
 * the toolsuite gates' read-only scan): no `next/*`, no `@/lib/api-utils`, no writes.
 */

import prisma from "@/lib/prisma";
import { approvedProductIds } from "@/lib/reports/outbound-mix";
import {
  callerWindowCoverage,
  salesCoverageReason,
  salesDataStartsByCompany,
  type CompanyCoverageEntry,
} from "@/lib/assistant/sales-coverage";
import type { WindowCoverage } from "@/lib/reports/metrics-contract";

/** The order-signal window: 90 UTC calendar day keys ending today (echoed by the tool). */
export const ORDER_SIGNAL_WINDOW_DAYS = 90;

export interface OrderSignalResult {
  /** Products WITH at least one fact row in the window. Absence is decided by coverage. */
  byProduct: Map<number, { orderedUnits: number; orders: number }>;
  windowCoverage: WindowCoverage;
  /** Only when `partial`: "window" = the records themselves begin inside the window;
   *  "company" = covered caller-wide, but a member company is not recording. */
  partialKind?: "window" | "company";
  /** The first day any of the caller's companies has an approved-active fact; null = none. */
  salesDataStart: string | null;
  /** Why a missing fact row is not a zero (present whenever coverage is not `full`). */
  reason?: string;
  /** The per-company first-fact days, present only when the companies do not share one
   *  start — the tool relays them (pack C4: `coverage.orderSignalCompanyCoverage`). */
  companyCoverage?: CompanyCoverageEntry[];
}

/**
 * Recorded ordered units + orders per product over `window`, in the caller's companies.
 *
 * Empty `productIds` or `companyIds` → no query; an empty map, coverage `none`.
 */
export async function orderSignal(
  productIds: number[],
  companyIds: string[],
  window: { from: string; to: string },
): Promise<OrderSignalResult> {
  if (productIds.length === 0 || companyIds.length === 0) {
    return {
      byProduct: new Map(),
      windowCoverage: "none",
      salesDataStart: null,
      reason: salesCoverageReason(null, window.from),
    };
  }

  // The coverage scope is the reorder population (approved + active), read once.
  const scopeIds = await approvedProductIds({ includeArchived: false });
  const [starts, groups] = await Promise.all([
    salesDataStartsByCompany(companyIds, { productId: { in: scopeIds } }),
    prisma.productSalesFact.groupBy({
      by: ["productId"],
      where: {
        productId: { in: productIds },
        companyId: { in: companyIds },
        dayKey: { gte: window.from, lte: window.to },
      },
      _sum: { orderedQty: true, orderCount: true },
    }) as unknown as Promise<
      Array<{ productId: number; _sum: { orderedQty: number | null; orderCount: number | null } }>
    >,
  ]);

  const byProduct = new Map<number, { orderedUnits: number; orders: number }>();
  for (const g of groups ?? []) {
    byProduct.set(g.productId, {
      orderedUnits: g._sum?.orderedQty ?? 0,
      orders: g._sum?.orderCount ?? 0,
    });
  }

  const companyCoverage = starts.staggered ? starts.perCompany : undefined;
  const windowCoverage = callerWindowCoverage(
    { salesDataStart: starts.salesDataStart, companyCoverage },
    window.from,
  );
  const result: OrderSignalResult = {
    byProduct,
    windowCoverage,
    salesDataStart: starts.salesDataStart,
    ...(companyCoverage ? { companyCoverage } : {}),
  };
  if (windowCoverage === "partial") {
    // The source itself starting inside the window is the WINDOW kind, whatever the
    // member companies do; otherwise a member company not recording made it partial.
    result.partialKind =
      starts.salesDataStart != null && starts.salesDataStart > window.from ? "window" : "company";
  }
  if (windowCoverage !== "full") {
    result.reason = salesCoverageReason(starts.salesDataStart, window.from, companyCoverage);
  }
  return result;
}
