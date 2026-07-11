/**
 * lib/history/union-timeline.ts — the per-product History timeline contract
 * (Lane 3 spec §3 D2 as amended by §10 R-L2/R-L3/R-L4/R-L5 + §11 D-L5).
 *
 * Merges two record streams for one product into a single, keyset-paginated,
 * batch-grouped timeline:
 *   - audit EVENTS in set E: `entityType IN ('PRODUCT','INVENTORY') AND
 *     entityId = productId`, UNION events whose batchId appears on any of the
 *     product's ledger rows (this keys bulk/order events — whose entityId is not
 *     the product — into the timeline via the batchId join Phase C built);
 *   - ORPHAN ledger rows: rows with `batchId IS NULL` (pre-Phase-C history,
 *     `legacy-unlinked`) or a batchId that no audit event carries (anti-join
 *     fallback, `missing-summary-event`).
 * A ledger row whose batch has an event renders ONLY under that event; every
 * ledger row appears exactly once across all pages.
 *
 * Ordering: desc `(ts, sourceRank, id)` with `event=0 < ledger=1` (events first
 * at equal ts). Row->event correlation within a batch (batchId is a GROUP key,
 * NOT a row->event FK — a batch transfer writes N events + 2N rows under ONE
 * batchId) uses, in order: (1) `details.transferId === row.transferId`;
 * (2) `details.items[].inventoryLogId` contains the row id; (3) sole-event fast
 * path; (4) else the batch's `unassignedRows` bucket. The partition is computed
 * over the batch's FULL event set so it is identical whether the batch is
 * emitted whole (unpaginated) or one event per page.
 *
 * Output is a strict field ALLOWLIST — never `ip`/`userAgent`/`email`/raw
 * `details`. Company-scoped events (`companyId` set) that the caller is not a
 * member of (and is not admin for) are projected to `restricted:true`: their
 * changes/snapshot/cascade/bulk are nulled and `action` becomes a truthful stub;
 * this product's ledger rows still show (global physical pool).
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { actionMeta, type ActionMeta } from '@/lib/change-tracking/taxonomy';
import { extractChanges, type ChangePair } from '@/lib/change-tracking/extract-changes';

const MAX_ID_SENTINEL = Number.MAX_SAFE_INTEGER;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SOURCE_RANK_EVENT = 0;
const SOURCE_RANK_LEDGER = 1;

export interface TimelineCursor {
  ts: string;
  lastEventId: number;
  lastLedgerId: number;
}

export interface RenderableLedgerRow {
  id: number;
  ts: string;
  delta: number;
  logType: string;
  reasonCode: string | null;
  unitCostCents: number | null;
  locationName: string | null;
  transferId: string | null;
  userName: string | null;
}

export interface RenderableAuditEvent {
  id: number;
  ts: string;
  actionType: string;
  meta: ActionMeta;
  actorKind: string;
  actorName: string | null;
  action: string;
  changes: Record<string, ChangePair> | null;
  snapshotFieldCount: number | null;
  cascadeCount: number | null;
  bulkRowCount: number | null;
  batchId: string | null;
  affectedCount: number;
  restricted: boolean;
}

export type TimelineEntry =
  | {
      kind: 'event';
      ts: string;
      event: RenderableAuditEvent;
      ledgerRows: RenderableLedgerRow[];
      unassignedRows: RenderableLedgerRow[];
    }
  | {
      kind: 'ledger';
      ts: string;
      ledgerRows: RenderableLedgerRow[];
      orphanKind: 'legacy-unlinked' | 'missing-summary-event';
    };

// ---------------------------------------------------------------------------
// Raw row helpers
// ---------------------------------------------------------------------------

type RawLedgerRow = {
  id: number;
  changeTime: Date;
  delta: number;
  logType: string;
  reasonCode: string | null;
  unitCostCents: number | null;
  transferId: string | null;
  batchId: string | null;
  locations: { name: string } | null;
  users: { username: string } | null;
};

type RawAuditEvent = {
  id: number;
  createdAt: Date;
  actionType: string;
  actorKind: string;
  action: string;
  companyId: string | null;
  batchId: string | null;
  affectedCount: number;
  details: Prisma.JsonValue;
  user: { id: number; username: string } | null;
};

const LEDGER_INCLUDE = {
  locations: { select: { name: true } },
  users: { select: { username: true } },
} as const;

const LEDGER_SELECT_FIELDS = {
  id: true,
  changeTime: true,
  delta: true,
  logType: true,
  reasonCode: true,
  unitCostCents: true,
  transferId: true,
  batchId: true,
} as const;

function toRenderableRow(r: RawLedgerRow): RenderableLedgerRow {
  return {
    id: r.id,
    ts: r.changeTime.toISOString(),
    delta: r.delta,
    logType: String(r.logType),
    reasonCode: r.reasonCode ?? null,
    unitCostCents: r.unitCostCents ?? null,
    locationName: r.locations?.name ?? null,
    transferId: r.transferId ?? null,
    userName: r.users?.username ?? null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotFieldCount(details: Record<string, unknown>): number | null {
  const snap = details.snapshot;
  return isPlainObject(snap) ? Object.keys(snap).length : null;
}

function cascadeCount(details: Record<string, unknown>): number | null {
  const cascade = details.cascade;
  if (!isPlainObject(cascade)) return null;
  // "M children": arrays contribute their length, pre-capped counts their value,
  // any other category one.
  return Object.values(cascade).reduce<number>((sum, v) => {
    if (Array.isArray(v)) return sum + v.length;
    if (typeof v === 'number' && Number.isFinite(v)) return sum + v;
    return sum + 1;
  }, 0);
}

function bulkRowCount(details: Record<string, unknown>): number | null {
  if (typeof details.rowCount === 'number' && Number.isFinite(details.rowCount)) {
    return details.rowCount;
  }
  return Array.isArray(details.rows) ? details.rows.length : null;
}

// ---------------------------------------------------------------------------
// Internal stream items (heads only; member rows are attached after slicing)
// ---------------------------------------------------------------------------

type EventItem = {
  rank: 0;
  tsMs: number;
  ts: string;
  id: number;
  event: RawAuditEvent;
};

type LedgerItem = {
  rank: 1;
  tsMs: number;
  ts: string;
  id: number; // GROUP REP id = max member id (ordering AND cursor resume)
  orphanKind: 'legacy-unlinked' | 'missing-summary-event';
  rows: RawLedgerRow[];
};

type StreamItem = EventItem | LedgerItem;

/** Global order: ts desc, rank asc (event before ledger), id desc. */
function compareStreamItems(a: StreamItem, b: StreamItem): number {
  if (a.tsMs !== b.tsMs) return b.tsMs - a.tsMs;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return b.id - a.id;
}

// ---------------------------------------------------------------------------
// getProductTimeline
// ---------------------------------------------------------------------------

export async function getProductTimeline(opts: {
  productId: number;
  caller: { userId: number; isAdmin: boolean };
  before?: TimelineCursor;
  limit?: number;
}): Promise<{
  entries: TimelineEntry[];
  nextCursor: TimelineCursor | null;
  dataStart: { events: string | null; ledger: string | null };
}> {
  const { productId, caller, before } = opts;
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const entityId = String(productId);
  const cursorTs = before ? new Date(before.ts) : null;

  // Q1: the product's distinct non-null ledger batchIds.
  const productBatchRows = await prisma.inventory_logs.findMany({
    where: { productId, batchId: { not: null } },
    select: { batchId: true },
    distinct: ['batchId'],
  });
  const productBatchIds = productBatchRows
    .map((r) => r.batchId)
    .filter((b): b is string => b != null);

  // Q3: which of those batchIds actually carry an audit event -> the rest are
  // missing-summary orphans (anti-join).
  let eventBatchIdSet = new Set<string>();
  if (productBatchIds.length > 0) {
    const evBatchRows = await prisma.auditLog.findMany({
      where: { batchId: { in: productBatchIds } },
      select: { batchId: true },
      distinct: ['batchId'],
    });
    eventBatchIdSet = new Set(evBatchRows.map((r) => r.batchId).filter((b): b is string => b != null));
  }
  const orphanBatchIds = productBatchIds.filter((b) => !eventBatchIdSet.has(b));

  // Caller company memberships (for R-L5 projection). Admins see everything.
  let callerCompanyIds = new Set<string>();
  if (!caller.isAdmin) {
    const memberships = await prisma.userCompany.findMany({
      where: { userId: caller.userId },
      select: { companyId: true },
    });
    callerCompanyIds = new Set(memberships.map((m) => m.companyId));
  }
  const isRestricted = (companyId: string | null): boolean => {
    if (!companyId || caller.isAdmin) return false;
    return !callerCompanyIds.has(companyId);
  };

  // Set-E membership OR (no keyset).
  const eOrBranches: Prisma.AuditLogWhereInput[] = [
    { entityType: { in: ['PRODUCT', 'INVENTORY'] }, entityId },
  ];
  if (productBatchIds.length > 0) eOrBranches.push({ batchId: { in: productBatchIds } });

  // ------------------------------------------------------------------
  // Q2: event heads (set E, keyset, limit+1)
  // ------------------------------------------------------------------
  const eventWhere: Prisma.AuditLogWhereInput = {
    AND: [
      { OR: eOrBranches },
      ...(cursorTs
        ? [
            {
              OR: [
                { createdAt: { lt: cursorTs } },
                { createdAt: cursorTs, id: { lt: before!.lastEventId } },
              ],
            } as Prisma.AuditLogWhereInput,
          ]
        : []),
    ],
  };
  const eventRows = (await prisma.auditLog.findMany({
    where: eventWhere,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      createdAt: true,
      actionType: true,
      actorKind: true,
      action: true,
      companyId: true,
      batchId: true,
      affectedCount: true,
      details: true,
      user: { select: { id: true, username: true } },
    },
  })) as unknown as RawAuditEvent[];
  const eventHasMore = eventRows.length > limit;

  const eventItems: EventItem[] = eventRows.map((e) => ({
    rank: SOURCE_RANK_EVENT,
    tsMs: e.createdAt.getTime(),
    ts: e.createdAt.toISOString(),
    id: e.id,
    event: e,
  }));

  // ------------------------------------------------------------------
  // Q4: orphan ledger rows -> grouped, cursor-VISIBLE stream items.
  //
  // The row-level keyset is only a DISCOVERY superset (R-L4): a multi-timestamp
  // missing-summary batch already emitted at its rep position re-enters the
  // window via its older-ts member rows (mass-update writes rows across multiple
  // transactions, so multi-ms batches are realistic). Group-level cursor
  // semantics:
  //   - an item's cursor id is its GROUP REP id (max member id);
  //   - an item is VISIBLE only if its rep position (tsMs, id) sorts strictly
  //     below the cursor (drops re-formed, already-emitted groups);
  //   - a dropped group's member rows can consume a whole window, so discovery
  //     keeps scanning below the last fetched row until limit+1 visible items
  //     exist or the rows run out (each iteration strictly advances past a
  //     non-empty window, so the scan terminates).
  // A NOT-yet-emitted group at the boundary ts has rep id < lastLedgerId and all
  // member ids <= rep id, so every member passes the row keyset and the group
  // stays discoverable; scanning desc, the FIRST member row encountered is at
  // the group's rep position, so items discovered later always sort below items
  // discovered earlier.
  // ------------------------------------------------------------------
  const ledgerOrBranches: Prisma.inventory_logsWhereInput[] = [{ batchId: null }];
  if (orphanBatchIds.length > 0) ledgerOrBranches.push({ batchId: { in: orphanBatchIds } });

  const cursorMs = cursorTs ? cursorTs.getTime() : null;
  const isVisibleItem = (tsMs: number, repId: number): boolean =>
    cursorMs === null ||
    tsMs < cursorMs ||
    (tsMs === cursorMs && repId < before!.lastLedgerId);

  const fetchLedgerWindow = async (
    floor: { ts: Date; id: number } | null,
  ): Promise<RawLedgerRow[]> => {
    const keyset = floor ?? (cursorTs ? { ts: cursorTs, id: before!.lastLedgerId } : null);
    const where: Prisma.inventory_logsWhereInput = {
      productId,
      AND: [
        { OR: ledgerOrBranches },
        ...(keyset
          ? [
              {
                OR: [
                  { changeTime: { lt: keyset.ts } },
                  { changeTime: keyset.ts, id: { lt: keyset.id } },
                ],
              } as Prisma.inventory_logsWhereInput,
            ]
          : []),
      ],
    };
    return (await prisma.inventory_logs.findMany({
      where,
      orderBy: [{ changeTime: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { ...LEDGER_SELECT_FIELDS, ...LEDGER_INCLUDE },
    })) as unknown as RawLedgerRow[];
  };

  const ledgerItems: LedgerItem[] = []; // visible items only
  const seenBatchIds = new Set<string>();
  let ledgerExhausted = false;
  let scanFloor: { ts: Date; id: number } | null = null;

  while (!ledgerExhausted && ledgerItems.length <= limit) {
    const window = await fetchLedgerWindow(scanFloor);
    if (window.length <= limit) ledgerExhausted = true;
    if (window.length === 0) break;

    // null-batch rows -> one 'legacy-unlinked' entry each (singleton groups;
    // the row keyset already guarantees visibility, checked uniformly anyway).
    for (const r of window) {
      if (r.batchId != null) continue;
      if (!isVisibleItem(r.changeTime.getTime(), r.id)) continue;
      ledgerItems.push({
        rank: SOURCE_RANK_LEDGER,
        tsMs: r.changeTime.getTime(),
        ts: r.changeTime.toISOString(),
        id: r.id,
        orphanKind: 'legacy-unlinked',
        rows: [r],
      });
    }

    // orphan-batch rows -> ONE 'missing-summary-event' entry per batchId, with
    // the group's rows fetched wholesale (a group is never split across pages).
    const newBatchIds = Array.from(
      new Set(window.map((r) => r.batchId).filter((b): b is string => b != null)),
    ).filter((b) => !seenBatchIds.has(b));
    for (const b of newBatchIds) seenBatchIds.add(b);
    if (newBatchIds.length > 0) {
      const rows = (await prisma.inventory_logs.findMany({
        where: { productId, batchId: { in: newBatchIds } },
        orderBy: [{ changeTime: 'desc' }, { id: 'desc' }],
        select: { ...LEDGER_SELECT_FIELDS, ...LEDGER_INCLUDE },
      })) as unknown as RawLedgerRow[];
      const byBatch = new Map<string, RawLedgerRow[]>();
      for (const r of rows) {
        if (r.batchId == null) continue;
        const list = byBatch.get(r.batchId) ?? [];
        list.push(r);
        byBatch.set(r.batchId, list);
      }
      for (const groupRows of Array.from(byBatch.values())) {
        const repId = Math.max(...groupRows.map((r) => r.id));
        const repTsMs = Math.max(...groupRows.map((r) => r.changeTime.getTime()));
        if (!isVisibleItem(repTsMs, repId)) continue; // already emitted at its rep position
        ledgerItems.push({
          rank: SOURCE_RANK_LEDGER,
          tsMs: repTsMs,
          ts: new Date(repTsMs).toISOString(),
          id: repId,
          orphanKind: 'missing-summary-event',
          rows: groupRows,
        });
      }
    }

    const lastRow = window[window.length - 1];
    scanFloor = { ts: lastRow.changeTime, id: lastRow.id };
  }

  // ------------------------------------------------------------------
  // Merge, slice
  // ------------------------------------------------------------------
  const merged: StreamItem[] = [...eventItems, ...ledgerItems].sort(compareStreamItems);
  const pageItems = merged.slice(0, limit);
  // !ledgerExhausted implies ledgerItems.length > limit (the loop only stops
  // early once it has limit+1 visible items), so merged.length > limit already
  // covers it — kept explicit for clarity.
  const hasMore = merged.length > limit || eventHasMore || !ledgerExhausted;

  // ------------------------------------------------------------------
  // Correlate member rows for emitted events (pagination-stable partition over
  // each batch's FULL event set — Q5 rows + Q5b sibling events).
  // ------------------------------------------------------------------
  const emittedEvents = pageItems.filter((i): i is EventItem => i.rank === SOURCE_RANK_EVENT);
  const emittedBatchIds = Array.from(
    new Set(emittedEvents.map((i) => i.event.batchId).filter((b): b is string => b != null)),
  );

  const eventLedgerRows = new Map<number, RenderableLedgerRow[]>();
  const eventUnassignedRows = new Map<number, RenderableLedgerRow[]>();
  for (const i of emittedEvents) {
    eventLedgerRows.set(i.event.id, []);
    eventUnassignedRows.set(i.event.id, []);
  }

  if (emittedBatchIds.length > 0) {
    // Q5: this product's member rows for the emitted batches.
    const memberRows = (await prisma.inventory_logs.findMany({
      where: { productId, batchId: { in: emittedBatchIds } },
      orderBy: [{ changeTime: 'asc' }, { id: 'asc' }],
      select: { ...LEDGER_SELECT_FIELDS, ...LEDGER_INCLUDE },
    })) as unknown as RawLedgerRow[];
    const memberRowsByBatch = new Map<string, RawLedgerRow[]>();
    for (const r of memberRows) {
      if (r.batchId == null) continue;
      const list = memberRowsByBatch.get(r.batchId) ?? [];
      list.push(r);
      memberRowsByBatch.set(r.batchId, list);
    }

    // Q5b: EVERY event of the emitted batches (id, batchId, details) so the
    // row->event partition is stable regardless of which events are on this page.
    const batchEventRows = (await prisma.auditLog.findMany({
      where: { batchId: { in: emittedBatchIds } },
      orderBy: [{ id: 'asc' }],
      select: { id: true, batchId: true, details: true },
    })) as unknown as { id: number; batchId: string | null; details: Prisma.JsonValue }[];
    const batchEventsByBatch = new Map<string, { id: number; details: Prisma.JsonValue }[]>();
    for (const e of batchEventRows) {
      if (e.batchId == null) continue;
      const list = batchEventsByBatch.get(e.batchId) ?? [];
      list.push({ id: e.id, details: e.details });
      batchEventsByBatch.set(e.batchId, list);
    }

    const emittedEventIds = new Set(emittedEvents.map((i) => i.event.id));

    for (const batchId of emittedBatchIds) {
      const rows = memberRowsByBatch.get(batchId) ?? [];
      const events = batchEventsByBatch.get(batchId) ?? [];
      if (rows.length === 0 || events.length === 0) continue;

      const assignment = new Map<number, number>(); // rowId -> eventId
      if (events.length === 1) {
        // Sole event for the batch -> all rows.
        for (const r of rows) assignment.set(r.id, events[0].id);
      } else {
        for (const r of rows) {
          const match =
            events.find((e) => transferIdOf(e.details) != null && transferIdOf(e.details) === r.transferId) ??
            events.find((e) => inventoryLogIdsOf(e.details).includes(r.id));
          if (match) assignment.set(r.id, match.id);
        }
      }

      // Rep = the batch's newest event (max id) — unassigned rows render there.
      const repEventId = events.reduce((m, e) => Math.max(m, e.id), -Infinity);
      const unassigned: RenderableLedgerRow[] = [];
      for (const r of rows) {
        const assignedTo = assignment.get(r.id);
        if (assignedTo == null) {
          unassigned.push(toRenderableRow(r));
          continue;
        }
        if (emittedEventIds.has(assignedTo)) {
          eventLedgerRows.get(assignedTo)!.push(toRenderableRow(r));
        }
      }
      if (unassigned.length > 0 && emittedEventIds.has(repEventId)) {
        eventUnassignedRows.set(repEventId, unassigned);
      }
    }
  }

  // ------------------------------------------------------------------
  // Build the response entries (strict allowlist projection)
  // ------------------------------------------------------------------
  const entries: TimelineEntry[] = pageItems.map((item) => {
    if (item.rank === SOURCE_RANK_LEDGER) {
      return {
        kind: 'ledger',
        ts: item.ts,
        ledgerRows: item.rows.map(toRenderableRow),
        orphanKind: item.orphanKind,
      };
    }
    const e = item.event;
    const restricted = isRestricted(e.companyId);
    const meta = actionMeta(e.actionType);
    const details = isPlainObject(e.details) ? (e.details as Record<string, unknown>) : {};
    const renderable: RenderableAuditEvent = {
      id: e.id,
      ts: item.ts,
      actionType: e.actionType,
      meta,
      actorKind: e.actorKind,
      actorName: e.user?.username ?? null,
      action: restricted ? `${meta.label} — company-scoped` : e.action,
      changes: restricted ? null : extractChanges(e.details),
      snapshotFieldCount: restricted ? null : snapshotFieldCount(details),
      cascadeCount: restricted ? null : cascadeCount(details),
      bulkRowCount: restricted ? null : bulkRowCount(details),
      batchId: e.batchId,
      affectedCount: e.affectedCount,
      restricted,
    };
    return {
      kind: 'event',
      ts: item.ts,
      event: renderable,
      ledgerRows: eventLedgerRows.get(e.id) ?? [],
      unassignedRows: eventUnassignedRows.get(e.id) ?? [],
    };
  });

  // ------------------------------------------------------------------
  // nextCursor (per-source min emitted id at the boundary ts; for ledger items
  // the id is the GROUP REP id — the visibility filter above pairs with it.
  // MAX sentinel when that source did not advance at the boundary ts)
  // ------------------------------------------------------------------
  let nextCursor: TimelineCursor | null = null;
  if (hasMore && pageItems.length > 0) {
    const last = pageItems[pageItems.length - 1];
    const boundaryMs = last.tsMs;
    let lastEventId = MAX_ID_SENTINEL;
    let lastLedgerId = MAX_ID_SENTINEL;
    for (const item of pageItems) {
      if (item.tsMs !== boundaryMs) continue;
      if (item.rank === SOURCE_RANK_EVENT) {
        lastEventId = Math.min(lastEventId, item.id);
      } else {
        lastLedgerId = Math.min(lastLedgerId, item.id);
      }
    }
    nextCursor = { ts: last.ts, lastEventId, lastLedgerId };
  }

  // ------------------------------------------------------------------
  // dataStart (per source, over the FULL set — no keyset)
  // ------------------------------------------------------------------
  const [eventsMin, ledgerMin] = await Promise.all([
    prisma.auditLog.aggregate({ _min: { createdAt: true }, where: { OR: eOrBranches } }),
    prisma.inventory_logs.aggregate({ _min: { changeTime: true }, where: { productId } }),
  ]);
  const dataStart = {
    events: eventsMin._min.createdAt ? eventsMin._min.createdAt.toISOString() : null,
    ledger: ledgerMin._min.changeTime ? ledgerMin._min.changeTime.toISOString() : null,
  };

  return { entries, nextCursor, dataStart };
}

// ---------------------------------------------------------------------------
// details correlation accessors (never surfaced in output)
// ---------------------------------------------------------------------------

function transferIdOf(details: Prisma.JsonValue): string | null {
  if (!isPlainObject(details)) return null;
  const t = (details as Record<string, unknown>).transferId;
  return typeof t === 'string' ? t : null;
}

function inventoryLogIdsOf(details: Prisma.JsonValue): number[] {
  if (!isPlainObject(details)) return [];
  const items = (details as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const ids: number[] = [];
  for (const it of items) {
    if (isPlainObject(it) && typeof it.inventoryLogId === 'number') ids.push(it.inventoryLogId);
  }
  return ids;
}
