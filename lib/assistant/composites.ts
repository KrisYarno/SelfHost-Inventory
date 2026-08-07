/**
 * lib/assistant/composites.ts — server-side composition for the two composite tools
 * (assistant toolsuite breadth, spec §5 T-360 get_product_overview + T-SNAP
 * get_business_snapshot; W3-A).
 *
 * These functions call the Wave-1/Wave-2 MODULE functions DIRECTLY (getValuation,
 * getPolicy, getMovementSeries, getInventorySummary, getReorderReport, getFreshness,
 * getOrderPipeline, callerScopedSalesCoverage) plus a handful of small direct reads —
 * NEVER the tool defs (a composite must not re-enter the tool envelope/pagination/
 * scope machinery; it composes the data layer).
 *
 * TRUTHFUL-DATA CORE (spec §5 T-360/T-SNAP, both adversarial gates):
 *  - EVERY section degrades INDEPENDENTLY. A section that throws (or a thin/absent
 *    source) becomes `{ status: "unavailable", reason }` and NEVER breaks its
 *    siblings — the whole overview/snapshot always returns, honestly labeled.
 *  - Each section carries its OWN scope ("global" | "company"). The sales/order
 *    sections are ALWAYS company-scoped via ctx.companyIds regardless of the outer
 *    "mixed" tool label (spec §6). The tool's static TOOL_SCOPES stays "global";
 *    the RESULT is `ok(..., { scope: "mixed" })`.
 *  - Sections are SUMMARIES, never lists: scalar KPIs, <=3 location rows, movement
 *    TOTALS only (not the point series). Deep dives route to the per-topic tools —
 *    the tool descriptions say so.
 *  - Structurally-unpopulated values are `null` with a named reason — never a
 *    fabricated 0 (velocity with no outbound signal is `avgDailyOutbound: null`,
 *    usageKnown false).
 *
 * MUST stay Next-free (imported by lib/assistant/tools.ts, which the MCP sidecar
 * builds without Next): no `next/*`, no `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { resolveAssistantProduct } from "@/lib/assistant/resolve-product";
import { getValuation } from "@/lib/analytics/valuation";
import { getPolicy } from "@/lib/reports/policy";
import { getMovementSeries } from "@/lib/reports/movement";
import { getInventorySummary } from "@/lib/reports/inventory-summary";
import { getReorderReport } from "@/lib/reports/reorder";
import { getFreshness } from "@/lib/assistant/freshness";
import { getOrderPipeline } from "@/lib/reports/order-pipeline";
import { callerScopedSalesCoverage } from "@/lib/assistant/sales-coverage";
import { approvedProductIds } from "@/lib/reports/outbound-mix";
import { resolveWindow } from "@/lib/assistant/window";
import {
  PHYSICAL_OUTBOUND_WHERE,
  PHYSICAL_OUTBOUND_DEFINITION,
  daysCovered,
} from "@/lib/reports/metrics-contract";
import { getLowStockDefault, effectiveLowStockThreshold, isLowStock } from "@/lib/stock-threshold";

const DAY_MS = 86_400_000;
const VELOCITY_WINDOW_DAYS = 30;
const SALES_WINDOW_DAYS = 30;
const SALES_SHORT_WINDOW_DAYS = 7;
const MAX_LOCATION_ROWS = 3;

/**
 * The byte-budget + company scope a composite receives. Kept as a MINIMAL local shape
 * (not the tools.ts ToolContext) so composites.ts does not import from tools.ts — that
 * would close a tools.ts → composites.ts → tools.ts import cycle at module init. The
 * tool computes `byteBudget = byteBudget(ctx)` and passes it in.
 */
export interface CompositeCtx {
  companyIds: string[];
  byteBudget: number;
}

export type SectionScope = "global" | "company";

/**
 * One composed section: an OK payload (scope + status:"ok" + the section's own fields
 * spread in) or a degraded one (scope + status:"unavailable" + a named reason). The
 * index signature carries the section-specific fields.
 */
export interface Section {
  scope: SectionScope;
  status: "ok" | "unavailable";
  reason?: string;
  [key: string]: unknown;
}

/**
 * Run one section's producer, degrading INDEPENDENTLY on any throw. A failing section
 * never propagates — it becomes `status:"unavailable"` + a reason, and the composite
 * as a whole still returns with its healthy siblings intact.
 */
async function runSection(
  scope: SectionScope,
  produce: () => Promise<Record<string, unknown>>,
): Promise<Section> {
  try {
    const data = await produce();
    return { scope, status: "ok", ...data };
  } catch (err) {
    // W3 seam-fix item 2 (codex M3): do NOT serialize err.message. A Prisma error can
    // embed connection hosts, database names, or schema identifiers in its message —
    // relaying that verbatim through a composite section would leak infrastructure
    // internals to the model (and any downstream surface). The reason is therefore a
    // FIXED, non-sensitive string; only the constructor NAME is surfaced (enough to tell
    // an AppError from a PrismaClientKnownRequestError without exposing the message body).
    const errorKind = err instanceof Error ? err.constructor.name : typeof err;
    return { scope, status: "unavailable", reason: "section unavailable", errorKind };
  }
}

/** Names of the sections whose status is "unavailable" — surfaced in coverage. */
function degradedOf(sections: Record<string, Section>): string[] {
  return Object.entries(sections)
    .filter(([, s]) => s.status === "unavailable")
    .map(([name]) => name);
}

// ===========================================================================
// T-360 — get_product_overview
// ===========================================================================

export interface OverviewCoverage {
  productId: number;
  sectionScopes: Record<string, SectionScope>;
  degradedSections: string[];
}

export interface ProductOverviewFound {
  found: true;
  productId: number;
  identity: Section;
  stockByLocation: Section;
  velocity: Section;
  valuation: Section;
  policy: Section;
  movement30: Section;
  sales30: Section;
  coverage: OverviewCoverage;
}

export type ProductOverview = { found: false; productId: number } | ProductOverviewFound;

/**
 * One-call product overview (spec §5 T-360). Resolves the product through the shared
 * approved-product resolver first — an unknown/pending-review/soft-deleted id returns
 * `{ found: false }` and the tool maps that to `notFound` (no section work happens).
 * Otherwise composes seven independently-degrading sections; the sales section is
 * company-scoped via `ctx.companyIds`.
 */
export async function getProductOverview(
  productId: number,
  ctx: CompositeCtx,
  now: Date = new Date(),
): Promise<ProductOverview> {
  const resolved = await resolveAssistantProduct(productId);
  if (!resolved) return { found: false, productId };

  const nowMs = now.getTime();

  const [identity, stockByLocation, velocity, valuation, policy, movement30, sales30] = await Promise.all([
    // identity (global): resolveAssistantProduct data + the shared stockState rule
    // (out wins over low — find_product's rule via the same stock-threshold helpers).
    runSection("global", async () => {
      const [product, systemDefault] = await Promise.all([
        prisma.product.findUnique({
          where: { id: productId },
          select: {
            name: true,
            baseName: true,
            variant: true,
            lowStockThreshold: true,
            product_locations: { select: { quantity: true } },
          },
        }),
        getLowStockDefault(),
      ]);
      if (!product) throw new Error("product detail not found");
      const currentStock = (product.product_locations ?? []).reduce((a, l) => a + l.quantity, 0);
      const effective = effectiveLowStockThreshold(product.lowStockThreshold, systemDefault);
      const low = isLowStock(currentStock, effective);
      const stockState: "in_stock" | "low" | "out" = currentStock <= 0 ? "out" : low ? "low" : "in_stock";
      return {
        name: product.name,
        baseName: product.baseName,
        variant: product.variant,
        currentStock,
        stockState,
      };
    }),

    // stockByLocation (global): the top <=3 locations by quantity + a note when more
    // exist (a SUMMARY — the full by-location breakdown is get_stock).
    runSection("global", async () => {
      const [rows, locs] = await Promise.all([
        prisma.product_locations.findMany({
          where: { productId },
          select: { locationId: true, quantity: true },
          orderBy: [{ quantity: "desc" }, { locationId: "asc" }],
        }),
        prisma.location.findMany({ select: { id: true, name: true } }),
      ]);
      const names = new Map<number, string>((locs ?? []).map((l) => [l.id, l.name]));
      const all = (rows ?? []).map((r) => ({
        locationId: r.locationId,
        quantity: r.quantity,
        locationName: names.get(r.locationId) ?? null,
      }));
      const out: Record<string, unknown> = {
        locations: all.slice(0, MAX_LOCATION_ROWS),
        totalLocations: all.length,
      };
      if (all.length > MAX_LOCATION_ROWS) {
        out.note =
          `Showing the top ${MAX_LOCATION_ROWS} of ${all.length} locations by quantity — ` +
          `use get_stock for the full by-location breakdown.`;
      }
      return out;
    }),

    // velocity (global): the SHARED physicalOutbound rate over the trailing 30 days
    // (units out / days-covered — spec §2 D2, never a flat /30) + the contract
    // definition string. No outbound signal => avgDailyOutbound null (unknown), never 0.
    runSection("global", async () => {
      const windowStart = new Date(nowMs - VELOCITY_WINDOW_DAYS * DAY_MS);
      const agg = await prisma.inventory_logs.aggregate({
        where: { ...PHYSICAL_OUTBOUND_WHERE, productId, changeTime: { gte: windowStart } },
        _sum: { delta: true },
        _min: { changeTime: true },
      });
      const firstMs = agg?._min?.changeTime?.getTime();
      const unitsOut30 = Math.abs(agg?._sum?.delta ?? 0);
      if (firstMs == null || unitsOut30 <= 0) {
        return {
          avgDailyOutbound: null,
          unitsOut30,
          windowDays: VELOCITY_WINDOW_DAYS,
          usageKnown: false,
          velocityDefinition: PHYSICAL_OUTBOUND_DEFINITION,
        };
      }
      const days = daysCovered(firstMs, nowMs, VELOCITY_WINDOW_DAYS);
      return {
        avgDailyOutbound: unitsOut30 / days,
        unitsOut30,
        daysCovered: days,
        windowDays: VELOCITY_WINDOW_DAYS,
        usageKnown: true,
        velocityDefinition: PHYSICAL_OUTBOUND_DEFINITION,
      };
    }),

    // valuation (global): the product's own row + coverage, relayed verbatim from
    // getValuation (cost/receipt/retail/margin, each null-with-coverage where unknown).
    runSection("global", async () => {
      const result = await getValuation({ productId, groupBy: "product" });
      return { row: result.rows[0] ?? null, coverage: result.coverage };
    }),

    // policy (global): effective + raw + per-field source (get_inventory_policy math).
    // W3 seam-fix item 3 (codex M2): the overview is a SUMMARY, so per-location minimums
    // are BOUNDED to the top MAX_LOCATION_ROWS with a "N more" note (mirrors
    // stockByLocation) — an unbounded relay could balloon the section on a product with
    // many locations. The full list stays behind get_inventory_policy.
    runSection("global", async () => {
      const result = await getPolicy({ productId });
      const rawProduct = result.product ?? null;
      if (!rawProduct) return { product: null, global: result.global };
      const mins = rawProduct.locationMinimums ?? [];
      const out: Record<string, unknown> = { global: result.global };
      if (mins.length > MAX_LOCATION_ROWS) {
        out.product = { ...rawProduct, locationMinimums: mins.slice(0, MAX_LOCATION_ROWS) };
        out.note =
          `Showing the top ${MAX_LOCATION_ROWS} of ${mins.length} per-location minimums — ` +
          `use get_inventory_policy for the full list.`;
      } else {
        out.product = rawProduct;
      }
      return out;
    }),

    // movement30 (global): 30-day ledger partition TOTALS only (a summary — the point
    // series is get_movement_series). Coverage relays the legacy-unclassified note.
    runSection("global", async () => {
      const window = resolveWindow({ relativeDays: VELOCITY_WINDOW_DAYS }, now, VELOCITY_WINDOW_DAYS);
      const result = await getMovementSeries({ productId, window, grain: "day" });
      return { window: result.window, totals: result.totals, coverage: result.coverage };
    }),

    // sales30 (COMPANY-scoped): ProductSalesFact sums for the caller's companies +
    // caller-scoped coverage. Empty scope => 0 units, no query (never fabricates).
    runSection("company", async () => {
      const window = resolveWindow({ relativeDays: SALES_WINDOW_DAYS }, now, SALES_WINDOW_DAYS);
      const scoped = ctx.companyIds.length > 0;
      const [coverage, agg] = await Promise.all([
        callerScopedSalesCoverage(ctx.companyIds),
        scoped
          ? prisma.productSalesFact.aggregate({
              where: {
                companyId: { in: ctx.companyIds },
                productId,
                dayKey: { gte: window.from, lte: window.to },
              },
              _sum: { orderedQty: true, revenue: true },
            })
          : Promise.resolve(null),
      ]);
      const out: Record<string, unknown> = {
        window,
        orderedUnits: agg?._sum?.orderedQty ?? 0,
        revenue: agg?._sum?.revenue != null ? String(agg._sum.revenue) : null,
        coverage,
      };
      if (!scoped) out.note = "You have no company access, so there are no sales to report.";
      return out;
    }),
  ]);

  const sections = { identity, stockByLocation, velocity, valuation, policy, movement30, sales30 };
  return {
    found: true,
    productId,
    ...sections,
    coverage: {
      productId,
      sectionScopes: {
        identity: identity.scope,
        stockByLocation: stockByLocation.scope,
        velocity: velocity.scope,
        valuation: valuation.scope,
        policy: policy.scope,
        movement30: movement30.scope,
        sales30: sales30.scope,
      },
      degradedSections: degradedOf(sections),
    },
  };
}

// ===========================================================================
// T-SNAP — get_business_snapshot
// ===========================================================================

export interface SnapshotCoverage {
  sectionScopes: Record<string, SectionScope>;
  degradedSections: string[];
}

export interface BusinessSnapshot {
  inventory: Section;
  reorderNow: Section;
  sales: Section;
  orderPipeline: Section;
  freshness: Section;
  coverage: SnapshotCoverage;
}

/**
 * Aggregate ProductSalesFact.orderedQty + revenue over a company-scoped window.
 *
 * G4/G5 (Task 3.1, gate cluster C): narrowed to the approved-ACTIVE id set per
 * get_business_snapshot's OWN policy row (spec C13) — the snapshot is a CURRENT-STATE
 * tool, so an archived product is excluded here even though the very same facts are
 * INCLUDED in get_sales. The caller computes the id set once and passes it, so a two-window
 * snapshot does not read the catalog twice.
 */
async function salesTotals(
  companyIds: string[],
  from: string,
  to: string,
  approvedActiveIds: number[],
): Promise<{ orderedUnits: number; revenue: string | null }> {
  if (companyIds.length === 0) return { orderedUnits: 0, revenue: null };
  const agg = await prisma.productSalesFact.aggregate({
    where: {
      companyId: { in: companyIds },
      productId: { in: approvedActiveIds },
      dayKey: { gte: from, lte: to },
    },
    _sum: { orderedQty: true, revenue: true },
  });
  return {
    orderedUnits: agg?._sum?.orderedQty ?? 0,
    revenue: agg?._sum?.revenue != null ? String(agg._sum.revenue) : null,
  };
}

/**
 * The "how's everything looking?" opener (spec §5 T-SNAP). Catalog KPIs + valuation +
 * stock-state census (global), reorder-now worklist count (global), sales 7/30d totals
 * (company-scoped), order-pipeline-by-status summary (company-scoped), and a freshness
 * one-liner (global). Every section degrades independently.
 */
export async function getBusinessSnapshot(
  ctx: CompositeCtx,
  now: Date = new Date(),
): Promise<BusinessSnapshot> {
  const win30 = resolveWindow({ relativeDays: SALES_WINDOW_DAYS }, now, SALES_WINDOW_DAYS);
  const win7 = resolveWindow({ relativeDays: SALES_SHORT_WINDOW_DAYS }, now, SALES_SHORT_WINDOW_DAYS);

  const [inventory, reorderNow, sales, orderPipeline, freshness] = await Promise.all([
    // inventory KPIs (global): catalog units + productCount + stockStateCounts +
    // valuation totals (with coverage). No ranked page — a snapshot is scalars only.
    runSection("global", async () => {
      const summary = await getInventorySummary({ byteBudget: ctx.byteBudget });
      return {
        unitsOnHand: summary.unitsOnHand,
        productCount: summary.productCount,
        stockStateCounts: summary.stockStateCounts,
        valuation: summary.valuation,
      };
    }),

    // reorder-now count (global): the worklist size (OUT/CRITICAL/REORDER_NOW), read
    // from the reorder report's own coverage — deep dive is reorder_report.
    runSection("global", async () => {
      const report = await getReorderReport({ includeOkay: false });
      return { reorderNowCount: report.coverage.suggested, coverage: report.coverage };
    }),

    // sales 7/30d totals (COMPANY-scoped): two separate windows + caller-scoped coverage.
    runSection("company", async () => {
      // Active-only (spec C13's policy row for this tool) — read ONCE for both windows,
      // and NOT AT ALL for a caller with no company access (there is no sales population
      // to scope, and that caller's snapshot has always resolved without querying).
      const approvedActiveIds = ctx.companyIds.length > 0 ? await approvedProductIds() : [];
      const [last7d, last30d, coverage] = await Promise.all([
        salesTotals(ctx.companyIds, win7.from, win7.to, approvedActiveIds),
        salesTotals(ctx.companyIds, win30.from, win30.to, approvedActiveIds),
        callerScopedSalesCoverage(ctx.companyIds),
      ]);
      return { last7d: { ...last7d, window: win7 }, last30d: { ...last30d, window: win30 }, coverage };
    }),

    // order pipeline summary (COMPANY-scoped): counts + revenue by status + open-order
    // aging over the last 30 days — deep dive is get_order_pipeline.
    runSection("company", async () => {
      const result = await getOrderPipeline({ window: win30, groupBy: "status", companyIds: ctx.companyIds });
      return { byStatus: result.orders, itemUnits: result.items, aging: result.aging, coverage: result.coverage };
    }),

    // freshness one-liner (global): rebuild recency + the fulfillment-sync note (which
    // is always "not observable from this process") — deep dive is get_data_freshness.
    runSection("global", async () => {
      const report = await getFreshness(ctx.companyIds);
      return {
        lastRunAt: report.rebuild.lastRunAt,
        sourceWatermark: report.rebuild.sourceWatermark,
        fulfillmentSyncNote: report.fulfillmentSync.reason,
        fulfillmentSyncCursor: report.fulfillmentSync.cursor,
        notTrackedCount: report.notTracked.length,
      };
    }),
  ]);

  const sections = { inventory, reorderNow, sales, orderPipeline, freshness };
  return {
    ...sections,
    coverage: {
      sectionScopes: {
        inventory: inventory.scope,
        reorderNow: reorderNow.scope,
        sales: sales.scope,
        orderPipeline: orderPipeline.scope,
        freshness: freshness.scope,
      },
      degradedSections: degradedOf(sections),
    },
  };
}
