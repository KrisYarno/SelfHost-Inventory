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
 *     caller can misread a global figure as scoped to them.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import { PHYSICAL_OUTBOUND_WHERE } from "@/lib/reports/metrics-contract";
import { callerScopedSalesCoverage } from "@/lib/assistant/sales-coverage";

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

/**
 * Compose a truthful one-line summary of FulfillmentSyncState's backfill columns
 * (`backfillComplete` / `backfillPage` / `backfillBefore` — there is no single
 * "backfill" column to relay verbatim). `null` only when there is no state row at
 * all (sync has never run); a row that exists but never started backfill reads
 * "not started", never null (the row IS the observation).
 */
function summarizeBackfill(row: {
  backfillComplete: boolean;
  backfillPage: number | null;
  backfillBefore: Date | null;
} | null): string | null {
  if (!row) return null;
  if (row.backfillComplete) return "complete";
  if (row.backfillPage != null || row.backfillBefore != null) {
    const before = row.backfillBefore ? row.backfillBefore.toISOString() : "unknown";
    const page = row.backfillPage ?? "unknown";
    return `in progress — page ${page}, before ${before}`;
  }
  return "not started";
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
    // fulfillmentSync cursor/backfill: the current deployment runs one active
    // WooCommerce integration, so the most-recently-updated FulfillmentSyncState row
    // is "the" sync state. A future multi-integration deployment would need this
    // widened to a per-integration breakdown — registered as a follow-up (see the
    // task report), not attempted here since the pinned FreshnessReport shape is a
    // single global block, not an array.
    prisma.fulfillmentSyncState.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { cursorModifiedAt: true, backfillComplete: true, backfillPage: true, backfillBefore: true },
    }),
    // sales.unattributedOrders (spec item 2): CONSUME W0-2's caller-scoped coverage.
    // NEVER read analytics_rebuild_state.unattributed directly — that counter is
    // global and would leak cross-company order volume to a company-scoped caller.
    callerScopedSalesCoverage(companyIds),
    // dataStarts.ledgerOutboundStart (global): first physical-outbound ledger row.
    prisma.inventory_logs.aggregate({ where: PHYSICAL_OUTBOUND_WHERE, _min: { changeTime: true } }),
    // dataStarts.ledgerSaleStart (global): first in-platform SALE ledger row.
    prisma.inventory_logs.aggregate({
      where: { logType: inventory_logs_logType.SALE, delta: { lt: 0 } },
      _min: { changeTime: true },
    }),
    // dataStarts.ledgerReceiptStart (global): first STOCK_IN receipt row.
    prisma.inventory_logs.aggregate({
      where: { logType: inventory_logs_logType.STOCK_IN },
      _min: { changeTime: true },
    }),
    // dataStarts.snapshotStart (global): first snapshot dayKey (already a date string).
    prisma.productStockSnapshot.aggregate({ _min: { dayKey: true } }),
    // dataStarts.ordersFirstSeen (CALLER-SCOPED): MIN over externalCreatedAt ??
    // createdAt, mirroring lib/analytics/rebuild-sales.ts's full-rebuild floor
    // computation — Prisma has no coalesce-aggregate, so two candidate rows (the
    // earliest non-null externalCreatedAt, and the earliest createdAt as the
    // fallback floor) are compared in JS. Empty companyIds -> no query at all.
    scoped
      ? Promise.all([
          prisma.externalOrder.findFirst({
            where: { companyId: { in: companyIds }, externalCreatedAt: { not: null } },
            orderBy: { externalCreatedAt: "asc" },
            select: { externalCreatedAt: true, createdAt: true },
          }),
          prisma.externalOrder.findFirst({
            where: { companyId: { in: companyIds } },
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
    fulfillmentSync: {
      enabled: null,
      reason: FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON,
      cursor: toIso(syncState?.cursorModifiedAt ?? null),
      backfill: summarizeBackfill(syncState),
    },
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
