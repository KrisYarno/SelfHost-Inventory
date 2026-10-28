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
 *  - LINKED before zero (A2 pack C14, A2-OCC-1): an order line on a store listing that is
 *    not linked to a product never becomes a sales fact (`lib/analytics/attribution.ts`),
 *    so a product with no fact row reads a measured zero only when it HAS a link on one of
 *    the caller's stores. Its unlinked case is returned in `unlinked`, and the window's
 *    orders carrying an unattributable line are counted (`unlinkedOrders`; A2 C17: a bundle
 *    line recorded without its components among them).
 *  - NO read touches the `Integration` table (it holds the encrypted store keys and the
 *    webhook secret) — not even a relation filter. The caller's stores are the
 *    `integrationId`s of the caller's own order records.
 *  - WHEN each linked no-fact product was last linked (A2 pack C16, A2-FD1-1): linking a
 *    listing back-fills its old order lines without a rebuild, so the same link reads return
 *    the newest link instant (`newestLinkAt`). This module knows nothing of rebuilds — the
 *    tool compares the instant with the last full sales rebuild.
 *
 * MUST stay Next-free and read-only (imported by the assistant-tool layer; registered in
 * the toolsuite gates' read-only scan): no `next/*`, no `@/lib/api-utils`, no writes.
 */

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { dayKeyStart, nextDayStart } from "@/lib/analytics/dates";
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
  /** A2 C14: the requested products with NO fact row in the window and no link — neither a
   *  `ProductLink` nor a bundle component — on any of the caller's stores. Their silence is
   *  not a zero: their orders could not have been attributed. Empty when coverage is `none`
   *  or every requested product has a fact row (the read does not run). */
  unlinked: Set<number>;
  /** A2 C14: the window's orders in the caller's companies with at least one line the fact
   *  rebuild cannot attribute to a product. 0 when the read does not run (same condition). */
  unlinkedOrders: number;
  /** A2 C16: for each no-fact LINKED product, the newest `createdAt` among its links on the
   *  caller's stores — a direct listing's own, a bundle component's bundle listing's (a
   *  component carries no `createdAt`). The same reads as `unlinked`, so empty whenever the
   *  link check does not run. */
  newestLinkAt: Map<number, Date>;
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
      unlinked: new Set(),
      unlinkedOrders: 0,
      newestLinkAt: new Map(),
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
  // A2 C14: a missing fact row is only a candidate zero when the records cover the window
  // at all, and only the products WITHOUT a fact row need the link check.
  const noFact = productIds.filter((productId) => !byProduct.has(productId));
  const linkCheckNeeded = windowCoverage !== "none" && noFact.length > 0;
  const [links, unlinkedOrders] = linkCheckNeeded
    ? await Promise.all([linkCheck(noFact, companyIds), unlinkedOrderCount(companyIds, window)])
    : [{ unlinked: new Set<number>(), newestLinkAt: new Map<number, Date>() }, 0];

  const result: OrderSignalResult = {
    byProduct,
    windowCoverage,
    salesDataStart: starts.salesDataStart,
    ...(companyCoverage ? { companyCoverage } : {}),
    unlinked: links.unlinked,
    unlinkedOrders,
    newestLinkAt: links.newestLinkAt,
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

/**
 * A2 C14: the no-fact products with NO link on the caller's stores. LINKED = a
 * `ProductLink` to the product on one of those stores, or a `BundleComponent` of the
 * product whose bundle listing is on one of them (attribution credits a bundle's frozen
 * components). The stores are the `integrationId`s of the caller's own orders — never an
 * `Integration` read — so a listing on a store with no recorded order counts as not linked:
 * the conservative direction (unknown, never a false 0).
 *
 * A2 C16: the same two reads also select when each listing was made — a component through
 * its bundle listing (`productLink.createdAt`; a component added to an existing bundle later
 * is not seen) — and return each linked product's newest instant. No other column is read.
 */
async function linkCheck(
  noFact: number[],
  companyIds: string[],
): Promise<{ unlinked: Set<number>; newestLinkAt: Map<number, Date> }> {
  const newestLinkAt = new Map<number, Date>();
  const stores = (await prisma.externalOrder.groupBy({
    by: ["integrationId"],
    where: { companyId: { in: companyIds } },
  })) as unknown as Array<{ integrationId: string }>;
  const storeIds = (stores ?? []).map((store) => store.integrationId);
  // No order on any store: nothing can be linked on one.
  if (storeIds.length === 0) return { unlinked: new Set(noFact), newestLinkAt };
  const [direct, components] = await Promise.all([
    prisma.productLink.findMany({
      where: { internalProductId: { in: noFact }, integrationId: { in: storeIds }, isBundle: false },
      select: { internalProductId: true, createdAt: true },
    }),
    prisma.bundleComponent.findMany({
      where: { internalProductId: { in: noFact }, productLink: { integrationId: { in: storeIds } } },
      select: { internalProductId: true, productLink: { select: { createdAt: true } } },
    }),
  ]);
  const linked = new Set<number>();
  const noteLink = (productId: number | null, createdAt: Date | null | undefined) => {
    if (productId == null) return;
    linked.add(productId);
    // `instanceof` guards a mocked read that leaves the column out (the product stays linked).
    if (!(createdAt instanceof Date)) return;
    const newest = newestLinkAt.get(productId);
    if (newest == null || createdAt > newest) newestLinkAt.set(productId, createdAt);
  };
  for (const row of direct ?? []) noteLink(row.internalProductId, row.createdAt);
  for (const row of components ?? []) noteLink(row.internalProductId, row.productLink?.createdAt);
  return { unlinked: new Set(noFact.filter((productId) => !linked.has(productId))), newestLinkAt };
}

/**
 * A2 C14: the window's orders in the caller's companies with at least one line the fact
 * rebuild cannot attribute — attribution's own predicates (`lib/analytics/attribution.ts`):
 * a cancelled order is skipped, and a line is unattributable when it has no listing or a
 * non-bundle listing with no product. A2 C17 (A2-QA-2): or a bundle line whose frozen
 * component snapshot is NULL — intake writes the snapshot on create only, so a line linked to
 * a bundle later (a re-sync) carries none, and attribution counts it unattributed.
 * `Prisma.AnyNull` matches the column's NULL and a stored JSON null alike (attribution reads
 * both as no components). A snapshot that is present but empty or malformed is unattributed
 * there too; this count does not read the snapshot's contents (pack C17 names the NULL branch
 * only) — the rebuild's own `unattributed` counter covers it. The day predicate is the
 * rebuild's (`lib/analytics/rebuild-sales.ts`: `externalCreatedAt`, else `createdAt`, over
 * the UTC day keys), so the count covers exactly the days the facts do.
 */
async function unlinkedOrderCount(
  companyIds: string[],
  window: { from: string; to: string },
): Promise<number> {
  const start = dayKeyStart(window.from);
  const end = nextDayStart(window.to);
  const count = await prisma.externalOrder.count({
    where: {
      companyId: { in: companyIds },
      // The column is non-null, so SQL `<>` drops no row here.
      internalStatus: { not: "cancelled" },
      OR: [
        { externalCreatedAt: { gte: start, lt: end } },
        { externalCreatedAt: null, createdAt: { gte: start, lt: end } },
      ],
      items: {
        some: {
          OR: [
            { productLinkId: null },
            { productLink: { isBundle: false, internalProductId: null } },
            { productLink: { isBundle: true }, bundleComponentSnapshot: { equals: Prisma.AnyNull } },
          ],
        },
      },
    },
  });
  return count ?? 0;
}
