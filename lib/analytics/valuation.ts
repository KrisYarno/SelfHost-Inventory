import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import { centsFromCostPrice, centsFromRetailPrice } from "@/lib/inventory";

// =============================================================================
// W1-VAL — inventory valuation module (spec §5 T-VAL).
//
// This module is SELF-CONTAINED: it owns `getValuationSummary` (moved verbatim
// from lib/analytics/queries.ts — the local copy there coexists until W1-INT
// replaces it with a re-export) and the private `latestReceiptCostByProduct`
// helper (also copied verbatim; SEAM for W1-INT: dedup with queries.ts).
// =============================================================================

/**
 * Latest STOCK_IN unit cost per product (R-L15 receipt-cost tie-break). groupBy
 * `_max(changeTime)` picks each product's most-recent receipt instant, then an
 * IN-fetch resolves the row; a same-timestamp tie is broken by the HIGHEST id
 * (rows are ordered id desc, first-seen-per-product wins). Value = that row's
 * `unitCostCents` (null when the winning receipt carries no frozen cost).
 * Products with no STOCK_IN row are absent from the map.
 *
 * SEAM (W1-INT): copied VERBATIM from lib/analytics/queries.ts (private there).
 * When queries.ts becomes a re-export of this module, delete the queries.ts copy
 * and have both `getValuationSummary` and `getValuation` share THIS one.
 */
async function latestReceiptCostByProduct(): Promise<Map<number, number | null>> {
  const maxTimes = await prisma.inventory_logs.groupBy({
    by: ["productId"],
    where: { logType: inventory_logs_logType.STOCK_IN },
    _max: { changeTime: true },
  });
  const pairs = maxTimes
    .filter((m) => m._max.changeTime != null)
    .map((m) => ({ productId: m.productId, changeTime: m._max.changeTime as Date }));
  if (pairs.length === 0) return new Map();

  const rows = await prisma.inventory_logs.findMany({
    where: { logType: inventory_logs_logType.STOCK_IN, OR: pairs },
    select: { id: true, productId: true, unitCostCents: true },
    orderBy: [{ id: "desc" }],
  });
  const out = new Map<number, number | null>();
  for (const r of rows) {
    // id desc => the first row seen for a product is the highest id among its
    // (already max-changeTime) ties. Later, lower-id ties are ignored.
    if (!out.has(r.productId)) out.set(r.productId, r.unitCostCents ?? null);
  }
  return out;
}

export interface ValuationSummary {
  atCurrentCostCents: number | null;
  costCoverage: { valued: number; of: number };
  atReceiptCostCents: number | null;
  receiptCoverage: { have: number; of: number };
}

/**
 * Inventory valuation tier 1 (spec D6 / Lane 6 review B2 / D-T2).
 * (a) value at CURRENT cost = SUM(current stock x costPrice) over products with a
 *     KNOWN cost. `costCoverage` reports how many of the products carry a cost;
 *     when NONE do (prod today: 0 of 80) `atCurrentCostCents` is `null` — the
 *     honest "no cost data on file", never "$0.00" for a stocked warehouse.
 * (b) value at last-receipt cost = SUM over in-stock products that HAVE receipt-cost
 *     data (products without it are EXCLUDED, surfaced via `receiptCoverage` — never
 *     blended silently). Receipt coverage is counted over IN-STOCK products only;
 *     `getValuationSummary`'s coverage blocks are the reference for the D-T1 contract.
 *
 * SEAM (W1-INT): copied VERBATIM from lib/analytics/queries.ts. queries.ts keeps
 * its own copy until W1-INT swaps it for `export { getValuationSummary } from
 * "@/lib/analytics/valuation"`.
 */
export async function getValuationSummary(): Promise<ValuationSummary> {
  const [products, receiptMap] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, approvalStatus: "APPROVED" },
      select: { id: true, costPrice: true, product_locations: { select: { quantity: true } } },
    }),
    latestReceiptCostByProduct(),
  ]);

  let atCurrentCostCents = 0;
  let valued = 0; // products carrying a known cost
  let atReceiptCostCents = 0;
  let have = 0;
  let receiptOf = 0;
  for (const p of products) {
    const currentStock = p.product_locations.reduce((a, l) => a + l.quantity, 0);
    const costCents = centsFromCostPrice(p.costPrice);
    if (costCents !== null) {
      valued += 1;
      atCurrentCostCents += currentStock * costCents;
    }
    if (currentStock > 0) {
      receiptOf += 1;
      const receiptCents = receiptMap.get(p.id);
      if (receiptCents != null) {
        have += 1;
        atReceiptCostCents += currentStock * receiptCents;
      }
    }
  }

  return {
    atCurrentCostCents: valued > 0 ? atCurrentCostCents : null,
    costCoverage: { valued, of: products.length },
    atReceiptCostCents: have > 0 ? atReceiptCostCents : null,
    receiptCoverage: { have, of: receiptOf },
  };
}

// =============================================================================
// getValuation — grouped valuation with unit+product coverage (spec §5 T-VAL REV-2)
// =============================================================================

/**
 * Coverage counts BOTH products AND stocked units for EVERY value dimension, so
 * "one known-price unit among 1,001" reads as 1/1001 units — never "50% covered"
 * off the product ratio. Denominators are uniform: `ofProducts` = approved,
 * non-deleted products in scope; `ofUnits` = their summed on-hand units.
 *
 * `margin*` is the cost∧retail INTERSECTION (products/units where BOTH prices are
 * known) — it is NOT derivable from the separate cost/retail counts, because those
 * sets diverge. `receiptCosted*` counts in-stock products carrying a receipt cost
 * (mirrors `getValuationSummary`'s in-stock receipt denominator).
 */
export interface ValuationCoverage {
  costedProducts: number;
  ofProducts: number;
  costedUnits: number;
  ofUnits: number;
  retailPricedProducts: number;
  retailPricedUnits: number;
  receiptCostedProducts: number;
  receiptCostedUnits: number;
  marginProducts: number;
  marginUnits: number;
}

/**
 * One valuation row. Aggregate rows (`groupBy: "total"`) omit id fields; per-grain
 * rows carry `productId` OR `locationId` (+ `name`). Every money field is a
 * KNOWN-subtotal: `null` when nothing in the row's scope carries that component
 * (never a phantom $0.00), populated otherwise. `atRetailCents` follows retail
 * semantics — `null` = price unknown, `0` = genuinely free. `marginCents` is
 * populated ONLY when BOTH cost and retail are known (0-retail IS known, so margin
 * computes against it). `reasons` names why a field is structurally null.
 */
export interface ValuationRow {
  productId?: number;
  locationId?: number;
  name?: string | null;
  units: number;
  atCurrentCostCents: number | null;
  atReceiptCostCents: number | null;
  atRetailCents: number | null;
  marginCents: number | null;
  reasons?: Record<string, string>;
}

export interface ValuationResult {
  groupBy: "total" | "product" | "location";
  rows: ValuationRow[];
  coverage: ValuationCoverage;
}

const RECEIPT_NOT_LOCATION_ATTRIBUTABLE = "receipt cost is not location-attributable";

/**
 * Grouped inventory valuation (spec §5 T-VAL). `groupBy` = `total` (default) |
 * `product` | `location`; optional `productId` narrows the scope to one product
 * (this module takes an ALREADY-VALID id — resolution/not-found is the tool's job
 * at W1-INT; an unknown/out-of-scope id yields empty rows + zeroed coverage here).
 *
 * Scope predicate matches `getValuationSummary`: approved, non-deleted products.
 * Rows are deterministically ordered (productId / locationId asc) for stable paging.
 * Receipt cost is PRODUCT-grain only: location rows carry `atReceiptCostCents: null`
 * + the named reason, because receipt cost is not location-attributable.
 */
export async function getValuation(opts: {
  productId?: number;
  groupBy?: "total" | "product" | "location";
}): Promise<ValuationResult> {
  const groupBy = opts.groupBy ?? "total";

  const [products, receiptMap] = await Promise.all([
    prisma.product.findMany({
      where: {
        deletedAt: null,
        approvalStatus: "APPROVED",
        ...(opts.productId ? { id: opts.productId } : {}),
      },
      select: {
        id: true,
        name: true,
        costPrice: true,
        retailPrice: true,
        product_locations: {
          select: { locationId: true, quantity: true, locations: { select: { name: true } } },
        },
      },
      orderBy: { id: "asc" },
    }),
    latestReceiptCostByProduct(),
  ]);

  // ---- one coverage block over the whole scope (dimension-based, not row-based) ----
  const coverage: ValuationCoverage = {
    costedProducts: 0,
    ofProducts: 0,
    costedUnits: 0,
    ofUnits: 0,
    retailPricedProducts: 0,
    retailPricedUnits: 0,
    receiptCostedProducts: 0,
    receiptCostedUnits: 0,
    marginProducts: 0,
    marginUnits: 0,
  };

  // ---- total-grain accumulators (KNOWN-subtotals) ----
  let totalUnits = 0;
  let totalCost = 0;
  let totalRetail = 0;
  let totalReceipt = 0;
  let totalMargin = 0;

  // ---- product-grain rows ----
  const productRows: ValuationRow[] = [];

  // ---- location-grain accumulators ----
  interface LocAcc {
    locationId: number;
    name: string | null;
    units: number;
    cost: number;
    hasCost: boolean;
    retail: number;
    hasRetail: boolean;
    margin: number;
    hasMargin: boolean;
  }
  const locMap = new Map<number, LocAcc>();

  for (const p of products) {
    const units = p.product_locations.reduce((a, l) => a + l.quantity, 0);
    const costCents = centsFromCostPrice(p.costPrice);
    const retailCents = centsFromRetailPrice(p.retailPrice);
    const receiptCents = receiptMap.get(p.id); // number | null | undefined
    const costKnown = costCents !== null;
    const retailKnown = retailCents !== null;
    // receipt is meaningful only for in-stock products (mirrors getValuationSummary).
    const receiptKnown = units > 0 && receiptCents != null;
    const marginKnown = costKnown && retailKnown;

    // --- coverage ---
    coverage.ofProducts += 1;
    coverage.ofUnits += units;
    if (costKnown) {
      coverage.costedProducts += 1;
      coverage.costedUnits += units;
    }
    if (retailKnown) {
      coverage.retailPricedProducts += 1;
      coverage.retailPricedUnits += units;
    }
    if (receiptKnown) {
      coverage.receiptCostedProducts += 1;
      coverage.receiptCostedUnits += units;
    }
    if (marginKnown) {
      coverage.marginProducts += 1;
      coverage.marginUnits += units;
    }

    // --- per-product money (each is units x per-unit cents, null when unknown) ---
    const rowCost = costKnown ? units * (costCents as number) : null;
    const rowRetail = retailKnown ? units * (retailCents as number) : null;
    const rowReceipt = receiptKnown ? units * (receiptCents as number) : null;
    const rowMargin = marginKnown ? units * ((retailCents as number) - (costCents as number)) : null;

    // --- total-grain accumulation (sum only the KNOWN components) ---
    totalUnits += units;
    if (costKnown) totalCost += rowCost as number;
    if (retailKnown) totalRetail += rowRetail as number;
    if (receiptKnown) totalReceipt += rowReceipt as number;
    if (marginKnown) totalMargin += rowMargin as number;

    // --- product-grain row ---
    if (groupBy === "product") {
      productRows.push({
        productId: p.id,
        name: p.name,
        units,
        atCurrentCostCents: rowCost,
        atReceiptCostCents: rowReceipt,
        atRetailCents: rowRetail,
        marginCents: rowMargin,
      });
    }

    // --- location-grain accumulation ---
    if (groupBy === "location") {
      for (const pl of p.product_locations) {
        const q = pl.quantity;
        let e = locMap.get(pl.locationId);
        if (!e) {
          e = {
            locationId: pl.locationId,
            name: pl.locations?.name ?? null,
            units: 0,
            cost: 0,
            hasCost: false,
            retail: 0,
            hasRetail: false,
            margin: 0,
            hasMargin: false,
          };
          locMap.set(pl.locationId, e);
        }
        e.units += q;
        if (costKnown) {
          e.cost += q * (costCents as number);
          e.hasCost = true;
        }
        if (retailKnown) {
          e.retail += q * (retailCents as number);
          e.hasRetail = true;
        }
        if (marginKnown) {
          e.margin += q * ((retailCents as number) - (costCents as number));
          e.hasMargin = true;
        }
      }
    }
  }

  // ---- assemble rows per grain ----
  let rows: ValuationRow[];
  if (products.length === 0) {
    // Unknown/out-of-scope productId (or empty catalog): no rows, zeroed coverage.
    rows = [];
  } else if (groupBy === "product") {
    rows = productRows.sort((a, b) => (a.productId as number) - (b.productId as number));
  } else if (groupBy === "location") {
    rows = Array.from(locMap.values())
      .sort((a, b) => a.locationId - b.locationId)
      .map((e) => ({
        locationId: e.locationId,
        name: e.name,
        units: e.units,
        atCurrentCostCents: e.hasCost ? e.cost : null,
        atReceiptCostCents: null, // receipt is not location-attributable
        atRetailCents: e.hasRetail ? e.retail : null,
        marginCents: e.hasMargin ? e.margin : null,
        reasons: { atReceiptCostCents: RECEIPT_NOT_LOCATION_ATTRIBUTABLE },
      }));
  } else {
    // total: one KNOWN-subtotal row; the coverage counts ARE the completeness disclosure.
    rows = [
      {
        units: totalUnits,
        atCurrentCostCents: coverage.costedProducts > 0 ? totalCost : null,
        atReceiptCostCents: coverage.receiptCostedProducts > 0 ? totalReceipt : null,
        atRetailCents: coverage.retailPricedProducts > 0 ? totalRetail : null,
        marginCents: coverage.marginProducts > 0 ? totalMargin : null,
      },
    ];
  }

  return { groupBy, rows, coverage };
}
