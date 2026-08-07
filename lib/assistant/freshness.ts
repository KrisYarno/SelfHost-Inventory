/**
 * lib/assistant/freshness.ts — data layer for the `get_data_freshness` assistant
 * tool (assistant toolsuite breadth, spec §5 T-FRESH REV-2).
 *
 * The honest answer to "how fresh is this data?" / "what do you track?". Three
 * truthfulness rules this module exists to enforce:
 *
 *  1. ENABLEMENT IS NOT OBSERVABLE (REV-2, codex). Whether the fulfillment-sync
 *     poller is turned on lives in an env flag on a sidecar process this app code
 *     never sees. `fulfillmentSync.enabled` is ALWAYS `null` with a fixed reason —
 *     NEVER inferred from row staleness (a stale cursor could mean "disabled" or
 *     just "next run hasn't fired yet"; guessing either way is a lie).
 *  2. Order-derived fields are CALLER-SCOPED (spec §3 E2's caller-scoping rule
 *     applied here too): `sales.unattributedOrders` and `dataStarts.ordersFirstSeen`
 *     filter by the caller's companyIds. `unattributedOrders` is consumed from
 *     `callerScopedSalesCoverage` (W0-2) — this module NEVER reads the global
 *     `analytics_rebuild_state.unattributed` counter directly.
 *  3. Ledger/snapshot dataStarts and `snapshots.flaggedPairs` are GLOBAL (the
 *     physical ledger and snapshot table carry no company column) — labeled as such
 *     via distinct key names (`ledgerOutboundStart` etc. vs `ordersFirstSeen`) so no
 *     caller can misread a global figure as scoped to them. "Global" means every
 *     company, NOT every product: the dataStarts are narrowed to the APPROVED universe
 *     (active + archived — the documented historical universe of this surface, G2-1),
 *     because a product this surface never reports must not date what it reports.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import { PHYSICAL_OUTBOUND_WHERE } from "@/lib/reports/metrics-contract";
import { callerScopedSalesCoverage } from "@/lib/assistant/sales-coverage";
import { approvedProductIds } from "@/lib/reports/outbound-mix";

const toIso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Fixed disclosure (REV-2, codex): the env flag lives in a sidecar process this app
 *  never observes. Never inferred from row staleness — see module doc rule 1. */
export const FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON =
  "not observable from this process; check the ops dashboard";

/**
 * The honest "what do you track?" list (spec §5 T-FRESH REV-2, EXPANDED). Anything
 * a legitimate owner question could ask about that this schema cannot truthfully
 * support lands here rather than a silent dead-end or a guessed number (G1).
 */
export const FRESHNESS_NOT_TRACKED: readonly string[] = [
  "fulfillment quantities (recorded in WooCommerce)",
  "purchase orders / on-order quantities",
  "supplier data",
  "lot / expiry tracking",
  "historical cost, retail, and policy values (only current values are stored)",
  "movement-by-actor breakdowns",
];

export interface FreshnessReport {
  rebuild: { lastRunAt: string | null; sourceWatermark: string | null };
  sales: { unattributedOrders: number; scope: "caller-companies" };
  fulfillmentSync: { enabled: null; reason: string; cursor: string | null; backfill: string | null };
  dataStarts: Record<string, string | null>;
  snapshots: { flaggedPairs: number; scope: "global" };
  notTracked: string[];
}

/** One FulfillmentSyncState row's observable columns. */
interface SyncRow {
  cursorModifiedAt: Date | null;
  backfillComplete: boolean;
  backfillPage: number | null;
  backfillBefore: Date | null;
}

/**
 * Compose a truthful one-line summary of a single row's backfill columns
 * (`backfillComplete` / `backfillPage` / `backfillBefore` — there is no single
 * "backfill" column to relay verbatim). A row that exists but never started backfill
 * reads "not started", never null (the row IS the observation).
 */
function summarizeBackfill(row: SyncRow): string {
  if (row.backfillComplete) return "complete";
  if (row.backfillPage != null || row.backfillBefore != null) {
    const before = row.backfillBefore ? row.backfillBefore.toISOString() : "unknown";
    const page = row.backfillPage ?? "unknown";
    return `in progress — page ${page}, before ${before}`;
  }
  return "not started";
}

/** Backfill-progress rank: the least-progressed integration sets the aggregate floor
 *  (not-started < in-progress < complete). */
function backfillRank(row: SyncRow): number {
  if (row.backfillComplete) return 2;
  if (row.backfillPage != null || row.backfillBefore != null) return 1;
  return 0;
}

/**
 * The backfill floor across integrations: the LEAST-progressed row (lowest rank). A tie
 * between two IN-PROGRESS rows (same rank 1) is broken DETERMINISTICALLY by page number —
 * least-progressed = LOWEST page — never by arbitrary array order (the old `<=` reduce
 * silently kept whichever row came first). A null page (progress tracked only by the
 * before-date) sorts LAST so a known low page wins; genuinely equal pages keep the first.
 */
function backfillFloorRow(rows: SyncRow[]): SyncRow {
  return rows.reduce((a, b) => {
    const ra = backfillRank(a);
    const rb = backfillRank(b);
    if (ra !== rb) return ra < rb ? a : b;
    if (ra === 1) {
      const pa = a.backfillPage ?? Number.POSITIVE_INFINITY;
      const pb = b.backfillPage ?? Number.POSITIVE_INFINITY;
      return pa <= pb ? a : b;
    }
    return a;
  });
}

/**
 * IN-WAVE FIX (W1-INT): prod runs TWO WooCommerce stores, so fulfillment freshness
 * must aggregate across ALL FulfillmentSyncState rows — never one store's row read as
 * "the" state (which would silently hide a lagging second store). The OLDEST cursor
 * across integrations is the freshness floor; the LEAST-progressed backfill is the
 * floor; the integration count is disclosed in both strings. `enabled` stays null
 * (enablement is still not observable from this process — module rule 1).
 */
function aggregateFulfillmentSync(rows: SyncRow[]): {
  enabled: null;
  reason: string;
  cursor: string | null;
  backfill: string | null;
} {
  const n = rows.length;
  const base = { enabled: null as null, reason: FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON };
  if (n === 0) {
    // No sync-state row at all — sync has never run for any integration.
    return { ...base, cursor: null, backfill: null };
  }
  const suffix = ` (oldest of ${n} integration${n === 1 ? "" : "s"})`;

  // Cursor floor across integrations. A never-cursored store must NOT be hidden behind a
  // fresher one: filtering the nulls out and taking min would let a fresh cursor read as
  // "the" floor, silently concealing a store that has never synced. So if ANY row lacks a
  // cursor, refuse the misleading date and disclose the count; only when EVERY store has a
  // cursor is the oldest a truthful freshness floor.
  const nullCursorCount = rows.filter((r) => r.cursorModifiedAt == null).length;
  let cursor: string | null;
  if (nullCursorCount > 0) {
    cursor = `no reliable cursor (${nullCursorCount} of ${n} integration${n === 1 ? "" : "s"} have no cursor yet)`;
  } else {
    const oldestCursor = rows
      .map((r) => r.cursorModifiedAt as Date)
      .reduce((a, b) => (a < b ? a : b));
    cursor = oldestCursor.toISOString() + suffix;
  }

  // Least-progressed backfill across integrations sets the aggregate floor (ties between
  // in-progress stores broken by lowest page — see backfillFloorRow).
  const floorRow = backfillFloorRow(rows);

  return {
    ...base,
    cursor,
    backfill: summarizeBackfill(floorRow) + suffix,
  };
}

/**
 * get_data_freshness data layer (spec §5 T-FRESH). `companyIds` scopes the
 * order-derived fields only (`sales.unattributedOrders`, `dataStarts.ordersFirstSeen`);
 * everything else is the global physical/analytics state. Empty `companyIds` short-
 * circuits the order-derived fields to null/0 WITHOUT querying — never throws, never
 * fabricates a number for a caller with no companies.
 */
export async function getFreshness(companyIds: string[]): Promise<FreshnessReport> {
  const scoped = companyIds.length > 0;
  // G2-1: the ledger/snapshot dataStarts are a CLAIM about the universe this surface
  // reports on, so they are narrowed to it — the DOCUMENTED historical universe, approved
  // ACTIVE + ARCHIVED (an archived product's history is real and is reported by the
  // historical tools; a pending-review product's is reported nowhere and must date
  // nothing). Applied even when empty: `in: []` reads as "no rows in scope", which is
  // exactly true, rather than silently reverting to a table-wide minimum.
  const approvedScope = { productId: { in: await approvedProductIds({ includeArchived: true }) } };

  const [
    salesRebuildState,
    snapshotsRebuildState,
    syncState,
    coverage,
    outboundStart,
    saleStart,
    receiptStart,
    snapshotStart,
    orderCandidates,
  ] = await Promise.all([
    // rebuild.lastRunAt / rebuild.sourceWatermark: the "sales" analytics-rebuild job
    // row (the job whose recency actually answers "how fresh is my data?" — spec §3
    // E2 already established job:"sales" as the recency source for this surface).
    prisma.analyticsRebuildState.findUnique({
      where: { job: "sales" },
      select: { lastRunAt: true, sourceWatermark: true },
    }),
    // snapshots.flaggedPairs: the "snapshots" job's counter — a DIFFERENT row from
    // the one above (flaggedPairs is populated by rebuildStockSnapshots, not the
    // sales rebuild). Labeled separately in the report on purpose (spec item 5).
    prisma.analyticsRebuildState.findUnique({
      where: { job: "snapshots" },
      select: { flaggedPairs: true },
    }),
    // fulfillmentSync cursor/backfill (IN-WAVE FIX, W1-INT): prod runs TWO WooCommerce
    // stores, so read ALL FulfillmentSyncState rows and aggregate — the oldest cursor +
    // least-progressed backfill are the freshness floor, and the integration count is
    // disclosed. `findFirst`-most-recent would have hidden a lagging second store.
    prisma.fulfillmentSyncState.findMany({
      select: { cursorModifiedAt: true, backfillComplete: true, backfillPage: true, backfillBefore: true },
    }),
    // sales.unattributedOrders (spec item 2): CONSUME W0-2's caller-scoped coverage.
    // NEVER read analytics_rebuild_state.unattributed directly — that counter is
    // global and would leak cross-company order volume to a company-scoped caller.
    callerScopedSalesCoverage(companyIds),
    // dataStarts.ledgerOutboundStart (global): first physical-outbound ledger row.
    prisma.inventory_logs.aggregate({
      where: { ...PHYSICAL_OUTBOUND_WHERE, ...approvedScope },
      _min: { changeTime: true },
    }),
    // dataStarts.ledgerSaleStart (global): first in-platform SALE ledger row.
    prisma.inventory_logs.aggregate({
      where: { logType: inventory_logs_logType.SALE, delta: { lt: 0 }, ...approvedScope },
      _min: { changeTime: true },
    }),
    // dataStarts.ledgerReceiptStart (global): first STOCK_IN receipt row.
    prisma.inventory_logs.aggregate({
      where: { logType: inventory_logs_logType.STOCK_IN, ...approvedScope },
      _min: { changeTime: true },
    }),
    // dataStarts.snapshotStart (global): first snapshot dayKey (already a date string).
    prisma.productStockSnapshot.aggregate({ where: approvedScope, _min: { dayKey: true } }),
    // dataStarts.ordersFirstSeen (CALLER-SCOPED): MIN over externalCreatedAt ??
    // createdAt, mirroring lib/analytics/rebuild-sales.ts's full-rebuild floor
    // computation — Prisma has no coalesce-aggregate, so two candidate rows are compared
    // in JS. Candidate 1 = the earliest non-null externalCreatedAt (rows with an external
    // date contribute THAT). Candidate 2 = the earliest createdAt among rows that have NO
    // external date (`externalCreatedAt IS NULL`) — those, and only those, contribute
    // their createdAt. A plain MIN(createdAt) OVERALL would wrongly pick a row whose
    // externalCreatedAt is non-null (its true, later contribution is that external date,
    // already covered by candidate 1), hiding the genuinely-earliest null-external row.
    // Empty companyIds -> no query at all.
    scoped
      ? Promise.all([
          prisma.externalOrder.findFirst({
            where: { companyId: { in: companyIds }, externalCreatedAt: { not: null } },
            orderBy: { externalCreatedAt: "asc" },
            select: { externalCreatedAt: true, createdAt: true },
          }),
          prisma.externalOrder.findFirst({
            where: { companyId: { in: companyIds }, externalCreatedAt: null },
            orderBy: { createdAt: "asc" },
            select: { externalCreatedAt: true, createdAt: true },
          }),
        ])
      : Promise.resolve([null, null] as const),
  ]);

  const orderStartCandidates = (orderCandidates as Array<{ externalCreatedAt: Date | null; createdAt: Date } | null>)
    .filter((o): o is { externalCreatedAt: Date | null; createdAt: Date } => o != null)
    .map((o) => o.externalCreatedAt ?? o.createdAt);
  const ordersFirstSeen = orderStartCandidates.length
    ? orderStartCandidates.reduce((a, b) => (a < b ? a : b))
    : null;

  return {
    rebuild: {
      lastRunAt: toIso(salesRebuildState?.lastRunAt ?? null),
      sourceWatermark: toIso(salesRebuildState?.sourceWatermark ?? null),
    },
    sales: {
      unattributedOrders: coverage.unattributedOrders,
      scope: "caller-companies",
    },
    fulfillmentSync: aggregateFulfillmentSync(syncState ?? []),
    dataStarts: {
      ledgerOutboundStart: toIso(outboundStart._min.changeTime),
      ledgerSaleStart: toIso(saleStart._min.changeTime),
      ledgerReceiptStart: toIso(receiptStart._min.changeTime),
      snapshotStart: snapshotStart._min.dayKey ?? null,
      ordersFirstSeen: toIso(ordersFirstSeen),
    },
    snapshots: {
      flaggedPairs: snapshotsRebuildState?.flaggedPairs ?? 0,
      scope: "global",
    },
    notTracked: [...FRESHNESS_NOT_TRACKED],
  };
}
