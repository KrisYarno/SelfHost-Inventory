/**
 * @jest-environment node
 *
 * Reference-model tests for `lib/history/union-timeline.ts`
 * (Lane 3 spec §3 D2 / §10 R-L2/R-L3/R-L4/R-L5).
 *
 * Prisma is faked with a small in-memory engine that faithfully applies
 * where (nested AND/OR + keyset predicates) / orderBy / take / distinct /
 * aggregate — the only way to prove keyset pagination determinism. The core
 * property: concat(all pages) === the unpaginated canonical result, no
 * dup / loss / split, across multi-event batches, missing-summary orphans,
 * legacy null-batch rows, and same-ms boundaries.
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    inventory_logs: { findMany: jest.fn(), aggregate: jest.fn() },
    auditLog: { findMany: jest.fn(), aggregate: jest.fn() },
    userCompany: { findMany: jest.fn() },
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import prisma from '@/lib/prisma';
import { getProductTimeline, type TimelineEntry } from '@/lib/history/union-timeline';

// ---------------------------------------------------------------------------
// In-memory prisma engine
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function cmpVal(a: any, b: any): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function matchField(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond !== 'object') return value === cond;
  if ('in' in cond) return Array.isArray(cond.in) && cond.in.includes(value);
  if ('not' in cond) return !matchField(value, cond.not);
  if ('lt' in cond) return value != null && cmpVal(value, cond.lt) < 0;
  if ('gt' in cond || 'gte' in cond || 'lte' in cond) {
    if (value == null) return false;
    if ('gt' in cond && !(cmpVal(value, cond.gt) > 0)) return false;
    if ('gte' in cond && !(cmpVal(value, cond.gte) >= 0)) return false;
    if ('lte' in cond && !(cmpVal(value, cond.lte) <= 0)) return false;
    return true;
  }
  return false;
}

function matchWhere(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as any[]).every((sub) => matchWhere(row, sub))) return false;
    } else if (key === 'OR') {
      if (!(cond as any[]).some((sub) => matchWhere(row, sub))) return false;
    } else if (!matchField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function applyOrderBy(rows: Row[], orderBy: any): Row[] {
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, dir] = Object.entries(clause)[0] as [string, string];
      const c = cmpVal(a[field], b[field]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

function applyDistinct(rows: Row[], fields: string[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    const key = fields.map((f) => String(r[f])).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function findMany(rows: Row[], args: any = {}): Row[] {
  let out = rows.filter((r) => matchWhere(r, args.where ?? {}));
  if (args.orderBy) out = applyOrderBy(out, args.orderBy);
  if (args.distinct) out = applyDistinct(out, args.distinct);
  if (typeof args.take === 'number') out = out.slice(0, args.take);
  return out;
}

function aggregate(rows: Row[], args: any): any {
  const filtered = rows.filter((r) => matchWhere(r, args.where ?? {}));
  const _min: Record<string, any> = {};
  for (const field of Object.keys(args._min ?? {})) {
    const vals = filtered.map((r) => r[field]).filter((v) => v != null);
    _min[field] = vals.length ? vals.reduce((m, v) => (cmpVal(v, m) < 0 ? v : m)) : null;
  }
  return { _min };
}

function install(db: { audit: Row[]; inv: Row[]; memberships: Row[] }) {
  const p = prisma as any;
  p.inventory_logs.findMany.mockImplementation(async (a: any) => findMany(db.inv, a));
  p.inventory_logs.aggregate.mockImplementation(async (a: any) => aggregate(db.inv, a));
  p.auditLog.findMany.mockImplementation(async (a: any) => findMany(db.audit, a));
  p.auditLog.aggregate.mockImplementation(async (a: any) => aggregate(db.audit, a));
  p.userCompany.findMany.mockImplementation(async (a: any) =>
    db.memberships.filter((m) => matchWhere(m, a.where ?? {})).map((m) => ({ companyId: m.companyId })),
  );
}

// ---------------------------------------------------------------------------
// Fixture (spec reference model)
// ---------------------------------------------------------------------------

const T = {
  t5: new Date('2026-07-05T10:00:00.000Z'),
  t4: new Date('2026-07-04T10:00:00.000Z'),
  t3: new Date('2026-07-03T10:00:00.000Z'),
  t2: new Date('2026-07-02T10:00:00.000Z'),
  t1: new Date('2026-07-01T10:00:00.000Z'),
};

function buildDb() {
  const usr = (username: string) => ({ id: 1, username, email: 'secret@x.com' });
  const loc = (name: string) => ({ name });
  const audit: Row[] = [
    // E1 — single-event adjustment batch for product 7
    { id: 101, createdAt: T.t5, actionType: 'INVENTORY_ADJUSTMENT', entityType: 'INVENTORY', entityId: '7', actorKind: 'USER', action: 'Adjusted inventory', companyId: null, batchId: 'b-adj', affectedCount: 1, details: { changes: { quantity: { from: 8, to: 5 } }, reasonCode: 'DAMAGE' }, ipAddress: '10.9.9.9', userAgent: 'SECRET-UA', user: usr('alice') },
    // E2 / E3 — multi-event transfer batch (transferId correlation)
    { id: 102, createdAt: T.t4, actionType: 'INVENTORY_TRANSFER', entityType: 'INVENTORY', entityId: '7', actorKind: 'USER', action: 'Transfer A', companyId: null, batchId: 'b-xfer', affectedCount: 1, details: { transferId: 'tid-A' }, ipAddress: '10.9.9.9', userAgent: 'SECRET-UA', user: usr('alice') },
    { id: 103, createdAt: T.t4, actionType: 'INVENTORY_TRANSFER', entityType: 'INVENTORY', entityId: '7', actorKind: 'USER', action: 'Transfer B', companyId: null, batchId: 'b-xfer', affectedCount: 1, details: { transferId: 'tid-B' }, ipAddress: '10.9.9.9', userAgent: 'SECRET-UA', user: usr('alice') },
    // E4 / E5 — multi-event fulfillment batch (items[].inventoryLogId correlation),
    // company-scoped, entityId is the ORDER (enters set E via the batchId join)
    { id: 104, createdAt: T.t3, actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityType: 'ORDER', entityId: 'order-1', actorKind: 'SYSTEM', action: 'Fulfilled order 1', companyId: 'c1', batchId: 'b-ful', affectedCount: 1, details: { items: [{ inventoryLogId: 501 }], orderId: 'ORD-SECRET', notes: 'customer note' }, ipAddress: '10.9.9.9', userAgent: 'SECRET-UA', user: null },
    { id: 105, createdAt: T.t3, actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityType: 'ORDER', entityId: 'order-2', actorKind: 'SYSTEM', action: 'Fulfilled order 2', companyId: 'c1', batchId: 'b-ful', affectedCount: 1, details: { items: [{ inventoryLogId: 502 }], orderId: 'ORD-SECRET-2', notes: 'note2' }, ipAddress: '10.9.9.9', userAgent: 'SECRET-UA', user: null },
    // Foreign product event — must NOT leak into product 7's timeline
    { id: 999, createdAt: T.t5, actionType: 'PRODUCT_UPDATE', entityType: 'PRODUCT', entityId: '8', actorKind: 'USER', action: 'Other product', companyId: null, batchId: null, affectedCount: 1, details: {}, ipAddress: '10.9.9.9', userAgent: 'SECRET-UA', user: usr('mallory') },
  ];
  const inv: Row[] = [
    { id: 401, productId: 7, changeTime: T.t5, delta: -3, logType: 'ADJUSTMENT', reasonCode: 'DAMAGE', unitCostCents: null, transferId: null, batchId: 'b-adj', locations: loc('Main'), users: { username: 'alice' } },
    { id: 411, productId: 7, changeTime: T.t4, delta: -1, logType: 'TRANSFER', reasonCode: null, unitCostCents: null, transferId: 'tid-A', batchId: 'b-xfer', locations: loc('Main'), users: { username: 'alice' } },
    { id: 412, productId: 7, changeTime: T.t4, delta: 1, logType: 'TRANSFER', reasonCode: null, unitCostCents: null, transferId: 'tid-A', batchId: 'b-xfer', locations: loc('Back'), users: { username: 'alice' } },
    { id: 413, productId: 7, changeTime: T.t4, delta: -1, logType: 'TRANSFER', reasonCode: null, unitCostCents: null, transferId: 'tid-B', batchId: 'b-xfer', locations: loc('Main'), users: { username: 'alice' } },
    { id: 414, productId: 7, changeTime: T.t4, delta: 1, logType: 'TRANSFER', reasonCode: null, unitCostCents: null, transferId: 'tid-B', batchId: 'b-xfer', locations: loc('Back'), users: { username: 'alice' } },
    { id: 501, productId: 7, changeTime: T.t3, delta: -2, logType: 'SALE', reasonCode: null, unitCostCents: null, transferId: null, batchId: 'b-ful', locations: loc('Main'), users: null },
    { id: 502, productId: 7, changeTime: T.t3, delta: -3, logType: 'SALE', reasonCode: null, unitCostCents: null, transferId: null, batchId: 'b-ful', locations: loc('Main'), users: null },
    // missing-summary orphan batch (no audit event carries b-mass)
    { id: 601, productId: 7, changeTime: T.t2, delta: -1, logType: 'ADJUSTMENT', reasonCode: 'COUNT', unitCostCents: null, transferId: null, batchId: 'b-mass', locations: loc('Main'), users: { username: 'bob' } },
    { id: 602, productId: 7, changeTime: T.t2, delta: -1, logType: 'ADJUSTMENT', reasonCode: 'COUNT', unitCostCents: null, transferId: null, batchId: 'b-mass', locations: loc('Main'), users: { username: 'bob' } },
    { id: 603, productId: 7, changeTime: T.t2, delta: 1, logType: 'ADJUSTMENT', reasonCode: 'COUNT', unitCostCents: null, transferId: null, batchId: 'b-mass', locations: loc('Back'), users: { username: 'bob' } },
    // legacy null-batch rows (pre-Phase-C), same ms
    { id: 701, productId: 7, changeTime: T.t1, delta: -1, logType: 'ADJUSTMENT', reasonCode: null, unitCostCents: null, transferId: null, batchId: null, locations: loc('Main'), users: { username: 'legacy' } },
    { id: 702, productId: 7, changeTime: T.t1, delta: 5, logType: 'STOCK_IN', reasonCode: null, unitCostCents: 250, transferId: null, batchId: null, locations: loc('Main'), users: { username: 'legacy' } },
    // foreign product row — must NOT leak
    { id: 801, productId: 8, changeTime: T.t5, delta: -1, logType: 'ADJUSTMENT', reasonCode: null, unitCostCents: null, transferId: null, batchId: null, locations: loc('Main'), users: { username: 'mallory' } },
  ];
  return { audit, inv, memberships: [] as Row[] };
}

const ADMIN = { userId: 1, isAdmin: true };

function ledgerIds(entry: TimelineEntry): number[] {
  return entry.ledgerRows.map((r) => r.id);
}

async function collectPages(
  caller: { userId: number; isAdmin: boolean },
  limit: number,
): Promise<TimelineEntry[]> {
  const all: TimelineEntry[] = [];
  let cursor: any = undefined;
  let guard = 0;
  do {
    const res = await getProductTimeline({ productId: 7, caller, before: cursor, limit });
    all.push(...res.entries);
    cursor = res.nextCursor ?? undefined;
    if (guard++ > 500) throw new Error('pagination did not terminate');
  } while (cursor);
  return all;
}

describe('getProductTimeline — canonical (unpaginated) reference model', () => {
  let canonical: Awaited<ReturnType<typeof getProductTimeline>>;
  beforeEach(async () => {
    install(buildDb());
    canonical = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
  });

  it('emits exactly the 8 groups in (ts desc, event<ledger, id desc) order', () => {
    const e = canonical.entries;
    expect(e).toHaveLength(8);
    expect(e[0]).toMatchObject({ kind: 'event' });
    expect((e[0] as any).event.id).toBe(101);
    expect((e[1] as any).event.id).toBe(103); // T4, id desc
    expect((e[2] as any).event.id).toBe(102);
    expect((e[3] as any).event.id).toBe(105); // T3, id desc
    expect((e[4] as any).event.id).toBe(104);
    expect(e[5]).toMatchObject({ kind: 'ledger', orphanKind: 'missing-summary-event' });
    expect(e[6]).toMatchObject({ kind: 'ledger', orphanKind: 'legacy-unlinked' });
    expect(ledgerIds(e[6])).toEqual([702]); // T1, id desc
    expect(e[7]).toMatchObject({ kind: 'ledger', orphanKind: 'legacy-unlinked' });
    expect(ledgerIds(e[7])).toEqual([701]);
  });

  it('correlates transfer rows by transferId (each event gets its own 2 legs)', () => {
    const e = canonical.entries;
    expect(ledgerIds(e[1])).toEqual([413, 414]); // E3 = tid-B
    expect((e[1] as any).unassignedRows).toEqual([]);
    expect(ledgerIds(e[2])).toEqual([411, 412]); // E2 = tid-A
  });

  it('correlates fulfillment rows by items[].inventoryLogId', () => {
    const e = canonical.entries;
    expect(ledgerIds(e[3])).toEqual([502]); // E5 -> logId 502
    expect(ledgerIds(e[4])).toEqual([501]); // E4 -> logId 501
  });

  it('single-event batch attaches all its rows; changes come via extractChanges', () => {
    const e0 = canonical.entries[0] as any;
    expect(ledgerIds(canonical.entries[0])).toEqual([401]);
    expect(e0.event.changes).toEqual({ quantity: { from: 8, to: 5 } });
    expect(e0.event.meta.group).toBe('INVENTORY');
  });

  it('missing-summary rows sharing a batchId form ONE grouped ledger entry', () => {
    const g = canonical.entries[5];
    expect(g.kind).toBe('ledger');
    expect(ledgerIds(g).sort((a, b) => a - b)).toEqual([601, 602, 603]);
  });

  it('does not leak foreign-product rows/events', () => {
    const allLedger = canonical.entries.flatMap((e) => e.ledgerRows.map((r) => r.id));
    expect(allLedger).not.toContain(801);
    const eventIds = canonical.entries
      .filter((e) => e.kind === 'event')
      .map((e) => (e as any).event.id);
    expect(eventIds).not.toContain(999);
  });

  it('reports per-source dataStart (min over the full sets)', () => {
    expect(canonical.dataStart.events).toBe(T.t3.toISOString());
    expect(canonical.dataStart.ledger).toBe(T.t1.toISOString());
  });
});

describe('getProductTimeline — keyset pagination determinism', () => {
  it('concat(all pages @limit=1) === canonical (no dup / loss / split)', async () => {
    install(buildDb());
    const canonical = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    install(buildDb());
    const paged = await collectPages(ADMIN, 1);
    expect(paged).toEqual(canonical.entries);
  });

  it('holds at limit=2 and limit=3 too', async () => {
    install(buildDb());
    const canonical = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    for (const lim of [2, 3]) {
      install(buildDb());
      const paged = await collectPages(ADMIN, lim);
      expect(paged).toEqual(canonical.entries);
    }
  });
});

describe('getProductTimeline — event/ledger at the same ms', () => {
  it('orders the event before the orphan ledger at equal ts and pages cleanly', async () => {
    const db = {
      audit: [
        { id: 10, createdAt: T.t3, actionType: 'INVENTORY_ADJUSTMENT', entityType: 'INVENTORY', entityId: '7', actorKind: 'USER', action: 'adj', companyId: null, batchId: null, affectedCount: 1, details: {}, ipAddress: 'x', userAgent: 'y', user: { id: 1, username: 'a', email: 'e' } },
      ],
      inv: [
        { id: 20, productId: 7, changeTime: T.t3, delta: -1, logType: 'ADJUSTMENT', reasonCode: null, unitCostCents: null, transferId: null, batchId: null, locations: { name: 'Main' }, users: { username: 'a' } },
      ],
      memberships: [] as Row[],
    };
    install(db);
    const canonical = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    expect(canonical.entries.map((e) => e.kind)).toEqual(['event', 'ledger']);
    install(db);
    const paged = await collectPages(ADMIN, 1);
    expect(paged).toEqual(canonical.entries);
  });
});

describe('getProductTimeline — multi-timestamp missing-summary batch at a page boundary', () => {
  // Orchestrator regression (T1 review): a mass-update batch with a failed
  // summary event writes rows across MULTIPLE timestamps (multi-tx). When the
  // page boundary lands exactly on the group's rep position, the next page's
  // row-level keyset re-discovers the batch via its older-ts member rows — the
  // group-level visibility filter must drop the re-formed group so
  // concat(pages) === canonical with the group appearing exactly once.
  const S = {
    t4: new Date('2026-07-04T10:00:00.000Z'),
    t3: new Date('2026-07-03T10:00:00.000Z'), // group rep ts (newest member row)
    t25: new Date('2026-07-02T15:00:00.000Z'), // interleaved other-source event
    t2: new Date('2026-07-02T10:00:00.000Z'), // older member row of the SAME batch
    t1: new Date('2026-07-01T10:00:00.000Z'),
  };
  function buildSpanDb() {
    return {
      audit: [
        // interleaved events from the OTHER source, above and between the
        // group's member timestamps
        { id: 100, createdAt: S.t4, actionType: 'INVENTORY_ADJUSTMENT', entityType: 'INVENTORY', entityId: '7', actorKind: 'USER', action: 'top adj', companyId: null, batchId: null, affectedCount: 1, details: {}, ipAddress: 'x', userAgent: 'y', user: { id: 1, username: 'a', email: 'e' } },
        { id: 60, createdAt: S.t25, actionType: 'PRODUCT_UPDATE', entityType: 'PRODUCT', entityId: '7', actorKind: 'USER', action: 'mid update', companyId: null, batchId: null, affectedCount: 1, details: {}, ipAddress: 'x', userAgent: 'y', user: { id: 1, username: 'a', email: 'e' } },
      ],
      inv: [
        // missing-summary batch 'b-span' spanning two timestamps; no audit event
        // carries b-span. Rep position = (t3, id 90).
        { id: 90, productId: 7, changeTime: S.t3, delta: -1, logType: 'ADJUSTMENT', reasonCode: null, unitCostCents: null, transferId: null, batchId: 'b-span', locations: { name: 'Main' }, users: { username: 'bob' } },
        { id: 40, productId: 7, changeTime: S.t2, delta: -2, logType: 'ADJUSTMENT', reasonCode: null, unitCostCents: null, transferId: null, batchId: 'b-span', locations: { name: 'Back' }, users: { username: 'bob' } },
        // legacy row below everything
        { id: 50, productId: 7, changeTime: S.t1, delta: 3, logType: 'ADJUSTMENT', reasonCode: null, unitCostCents: null, transferId: null, batchId: null, locations: { name: 'Main' }, users: { username: 'legacy' } },
      ],
      memberships: [] as Row[],
    };
  }

  it('canonical: 4 groups, span batch emitted ONCE at its rep ts with both rows', async () => {
    install(buildSpanDb());
    const canonical = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    expect(canonical.entries).toHaveLength(4);
    expect((canonical.entries[0] as any).event.id).toBe(100); // t4 event
    expect(canonical.entries[1]).toMatchObject({ kind: 'ledger', orphanKind: 'missing-summary-event' });
    expect(ledgerIds(canonical.entries[1]).sort((a, b) => a - b)).toEqual([40, 90]);
    expect((canonical.entries[2] as any).event.id).toBe(60); // t2.5 event (below the group rep, above its older row)
    expect(canonical.entries[3]).toMatchObject({ kind: 'ledger', orphanKind: 'legacy-unlinked' });
  });

  it('limit=2 puts the boundary exactly at the group rep — group appears exactly once', async () => {
    install(buildSpanDb());
    const canonical = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    install(buildSpanDb());
    // Page 1 = [event t4, span group]; boundary = the group's rep position.
    const first = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.entries[1]).toMatchObject({ kind: 'ledger', orphanKind: 'missing-summary-event' });
    expect(first.nextCursor).not.toBeNull();

    const paged = await collectPages(ADMIN, 2);
    expect(paged).toEqual(canonical.entries);
    const groupEmits = paged.filter(
      (e) => e.kind === 'ledger' && (e as any).orphanKind === 'missing-summary-event',
    );
    expect(groupEmits).toHaveLength(1);
    expect(ledgerIds(groupEmits[0]).sort((a, b) => a - b)).toEqual([40, 90]);
  });

  it('concat(all pages) === canonical at every page size 1..4', async () => {
    install(buildSpanDb());
    const canonical = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    for (const lim of [1, 2, 3, 4]) {
      install(buildSpanDb());
      const paged = await collectPages(ADMIN, lim);
      expect(paged).toEqual(canonical.entries);
    }
  });
});

describe('getProductTimeline — LLM actorDetail projection (Lane 4 D9)', () => {
  // For LLM-actor events the row's joined user IS the approving human (the D9
  // envelope's approvedByUserId writes the audit row's userId). The timeline
  // exposes it as the allowlisted `actorDetail` — ONLY the username string —
  // so renderers can show "Assistant · approved by kris". Non-LLM events carry
  // actorDetail: null.
  function buildLlmDb() {
    return {
      audit: [
        { id: 11, createdAt: T.t3, actionType: 'INVENTORY_ADJUSTMENT', entityType: 'INVENTORY', entityId: '7', actorKind: 'LLM', action: 'Adjusted inventory', companyId: null, batchId: null, affectedCount: 1, details: { envelope: { surface: 'assistant', approvedByUserId: 9 } }, ipAddress: 'x', userAgent: 'y', user: { id: 9, username: 'kris', email: 'secret@x.com' } },
        { id: 12, createdAt: T.t2, actionType: 'PRODUCT_UPDATE', entityType: 'PRODUCT', entityId: '7', actorKind: 'USER', action: 'Updated product', companyId: null, batchId: null, affectedCount: 1, details: {}, ipAddress: 'x', userAgent: 'y', user: { id: 1, username: 'alice', email: 'secret@x.com' } },
        { id: 13, createdAt: T.t1, actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityType: 'INVENTORY', entityId: '7', actorKind: 'SYSTEM', action: 'Fulfilled order', companyId: null, batchId: null, affectedCount: 1, details: {}, ipAddress: 'x', userAgent: 'y', user: null },
        // LLM event with NO joined user (defensive: no approver resolvable)
        { id: 14, createdAt: T.t4, actionType: 'INVENTORY_ADJUSTMENT', entityType: 'INVENTORY', entityId: '7', actorKind: 'LLM', action: 'Adjusted inventory', companyId: null, batchId: null, affectedCount: 1, details: {}, ipAddress: 'x', userAgent: 'y', user: null },
      ],
      inv: [] as Row[],
      memberships: [] as Row[],
    };
  }

  it('exposes the approver username as actorDetail on LLM events only', async () => {
    install(buildLlmDb());
    const res = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    const byId = new Map(
      res.entries.filter((e) => e.kind === 'event').map((e) => [(e as any).event.id, (e as any).event]),
    );
    expect(byId.get(11).actorDetail).toBe('kris');
    expect(byId.get(12).actorDetail).toBeNull(); // USER
    expect(byId.get(13).actorDetail).toBeNull(); // SYSTEM
    expect(byId.get(14).actorDetail).toBeNull(); // LLM without a resolvable approver
  });

  it('exposes ONLY the username string — nothing else from the join or envelope', async () => {
    install(buildLlmDb());
    const res = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    const json = JSON.stringify(res);
    expect(json).not.toContain('approvedByUserId');
    expect(json).not.toContain('envelope');
    expect(json).not.toContain('secret@x.com');
    expect(json).toContain('"actorDetail":"kris"');
  });
});

describe('getProductTimeline — authorization projection (R-L5)', () => {
  it('non-member caller: company-scoped events restricted, no ip/userAgent/email anywhere', async () => {
    install(buildDb()); // memberships empty => caller is a member of nothing
    const nonMember = { userId: 42, isAdmin: false };
    const res = await getProductTimeline({ productId: 7, caller: nonMember, limit: 50 });

    const byId = new Map(
      res.entries.filter((e) => e.kind === 'event').map((e) => [(e as any).event.id, e as any]),
    );

    // company-scoped fulfillment events -> restricted stub, details nulled
    for (const id of [104, 105]) {
      const ev = byId.get(id).event;
      expect(ev.restricted).toBe(true);
      expect(ev.action).toBe('Order fulfillment — company-scoped');
      expect(ev.changes).toBeNull();
      expect(ev.snapshotFieldCount).toBeNull();
      expect(ev.cascadeCount).toBeNull();
      expect(ev.bulkRowCount).toBeNull();
    }
    // ...but this product's ledger rows still render (global physical pool)
    expect(ledgerIds(byId.get(104))).toEqual([501]);
    expect(ledgerIds(byId.get(105))).toEqual([502]);

    // non-company events remain fully visible
    const e1 = byId.get(101).event;
    expect(e1.restricted).toBe(false);
    expect(e1.action).toBe('Adjusted inventory');
    expect(e1.changes).toEqual({ quantity: { from: 8, to: 5 } });

    // strict allowlist: nothing sensitive is anywhere in the serialized payload
    const json = JSON.stringify(res);
    for (const forbidden of [
      'ipAddress',
      'userAgent',
      'email',
      'SECRET-UA',
      '10.9.9.9',
      'secret@x.com',
      'ORD-SECRET',
      'customer note',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('admin sees company-scoped events unrestricted', async () => {
    install(buildDb());
    const res = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    const e4 = res.entries.find((e) => e.kind === 'event' && (e as any).event.id === 104) as any;
    expect(e4.event.restricted).toBe(false);
    expect(e4.event.action).toBe('Fulfilled order 1');
  });
});

// ---------------------------------------------------------------------------
// THE NOTE (reconciliation Part 2, pack § P2-B3-1R, R-a.2; owner decision row
// 107: seen by admins + its author). Non-null only for an INVENTORY_ADJUSTMENT
// (the adjust dialog and Stock In), never on a restricted event, only for an
// admin or the event's own user, and only when a non-empty trimmed legacy
// `reason` and/or `notes` exists — in that order, de-duplicated, ` — `-joined.
// ---------------------------------------------------------------------------

describe('getProductTimeline — the adjustment Note and its audience (R-a.2)', () => {
  const AUTHOR = { userId: 5, isAdmin: false };
  const OTHER_OPERATOR = { userId: 6, isAdmin: false };
  const bob = { id: 5, username: 'bob', email: 'secret@x.com' };

  const adjust = (id: number, details: Row, over: Row = {}): Row => ({
    id,
    createdAt: new Date(T.t5.getTime() - id * 1000),
    actionType: 'INVENTORY_ADJUSTMENT',
    entityType: 'INVENTORY',
    entityId: '7',
    actorKind: 'USER',
    action: `adjust ${id}`,
    companyId: null,
    batchId: null,
    affectedCount: 1,
    details,
    ipAddress: 'x',
    userAgent: 'y',
    user: bob,
    ...over,
  });

  function buildNoteDb() {
    return {
      audit: [
        adjust(1, { notes: 'counted twice' }),
        adjust(2, { reason: 'old words' }),
        adjust(3, { reason: 'damaged box', notes: 'photo on file' }),
        adjust(4, { reason: ' same ', notes: 'same' }),
        adjust(5, {}),
        adjust(6, { reason: '   ', notes: '' }),
        // Stock In's event is an INVENTORY_ADJUSTMENT with its marker (R-a.4).
        adjust(7, { source: 'stock-in', notes: 'pallet 3' }),
        // (a): a non-adjust event's `notes` is never a Note.
        adjust(8, { notes: 'transfer words' }, { actionType: 'INVENTORY_TRANSFER' }),
        // (b): the author's own adjustment, company-scoped to a company the
        // author is not a member of — restricted, so no Note even for them.
        adjust(9, { notes: 'scoped words' }, { companyId: 'c9' }),
        // No joined user: the author is unknown, so only an admin sees it.
        adjust(10, { notes: 'system words' }, { user: null }),
      ],
      inv: [] as Row[],
      memberships: [] as Row[],
    };
  }

  async function notesFor(caller: { userId: number; isAdmin: boolean }) {
    install(buildNoteDb());
    const res = await getProductTimeline({ productId: 7, caller, limit: 50 });
    return new Map(
      res.entries
        .filter((e) => e.kind === 'event')
        .map((e) => [(e as any).event.id as number, (e as any).event.note as string | null]),
    );
  }

  it('an admin sees the Note of every adjustment; the shape is reason then notes, de-duplicated, joined', async () => {
    const notes = await notesFor(ADMIN);
    expect(notes.get(1)).toBe('counted twice');
    expect(notes.get(2)).toBe('old words');
    expect(notes.get(3)).toBe('damaged box — photo on file');
    expect(notes.get(4)).toBe('same');
    expect(notes.get(5)).toBeNull();
    expect(notes.get(6)).toBeNull();
    expect(notes.get(7)).toBe('pallet 3');
    expect(notes.get(10)).toBe('system words');
  });

  it("the author sees their own Notes — legacy reasons included", async () => {
    const notes = await notesFor(AUTHOR);
    expect(notes.get(1)).toBe('counted twice');
    expect(notes.get(2)).toBe('old words');
    expect(notes.get(3)).toBe('damaged box — photo on file');
    expect(notes.get(7)).toBe('pallet 3');
    // An event with no joined user has no author to match.
    expect(notes.get(10)).toBeNull();
  });

  it('another operator sees no Note at all — not the new notes, not the legacy reason', async () => {
    const notes = await notesFor(OTHER_OPERATOR);
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(notes.get(id)).toBeNull();

    install(buildNoteDb());
    const json = JSON.stringify(
      await getProductTimeline({ productId: 7, caller: OTHER_OPERATOR, limit: 50 }),
    );
    for (const words of ['counted twice', 'old words', 'damaged box', 'photo on file', 'pallet 3']) {
      expect(json).not.toContain(words);
    }
  });

  it('a non-adjust event carrying `notes` -> null, for an admin as for its author (a)', async () => {
    expect((await notesFor(ADMIN)).get(8)).toBeNull();
    expect((await notesFor(AUTHOR)).get(8)).toBeNull();
  });

  it("a restricted adjustment -> null even for its author (b, the belt)", async () => {
    install(buildNoteDb());
    const res = await getProductTimeline({ productId: 7, caller: AUTHOR, limit: 50 });
    const ev = res.entries.find((e) => e.kind === 'event' && (e as any).event.id === 9) as any;
    expect(ev.event.restricted).toBe(true);
    expect(ev.event.note).toBeNull();
    expect(JSON.stringify(res)).not.toContain('scoped words');
  });

  it("the fulfillment's customer note never becomes a Note, even for an admin (a)", async () => {
    install(buildDb());
    const res = await getProductTimeline({ productId: 7, caller: ADMIN, limit: 50 });
    const byId = new Map(
      res.entries.filter((e) => e.kind === 'event').map((e) => [(e as any).event.id, (e as any).event]),
    );
    expect(byId.get(104).note).toBeNull();
    expect(byId.get(105).note).toBeNull();
    // The adjustment in the reference fixture carries no reason and no notes.
    expect(byId.get(101).note).toBeNull();
    expect(JSON.stringify(res)).not.toContain('customer note');
  });
});

// ---------------------------------------------------------------------------
// THE BOUNDARY (R-a.2): the Note is the operator's free text, so the module that
// projects it must never be on the model's path. A SOURCE SCAN — it loads
// nothing, so no mock can talk it out of its answer.
// ---------------------------------------------------------------------------

describe('union-timeline never reaches the assistant, the reports or the MCP sidecar (R-a.2)', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../..');
  const ROOTS = ['lib/assistant', 'lib/reports', 'mcp'];
  const SKIP = new Set(['node_modules', 'dist']);
  const IMPORTS_TIMELINE =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'][^"']*union-timeline(?:\.[cm]?[jt]sx?)?["']/;

  function walk(rel: string, out: string[]): void {
    const abs = path.join(REPO_ROOT, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child, out);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) out.push(child);
    }
  }

  const files: string[] = [];
  for (const root of ROOTS) walk(root, files);

  it('scans a real set of modules (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(20);
    for (const root of ROOTS) expect(files.some((f) => f.startsWith(root))).toBe(true);
  });

  it('no module under lib/assistant, lib/reports or mcp imports union-timeline', () => {
    const offenders = files.filter((f) =>
      IMPORTS_TIMELINE.test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern bites (positive controls)', () => {
    for (const src of [
      "import { getProductTimeline } from '@/lib/history/union-timeline';",
      'import type { TimelineEntry } from "../history/union-timeline";',
      "const t = require('@/lib/history/union-timeline');",
      "const t = await import('@/lib/history/union-timeline.ts');",
      "export { getProductTimeline } from '@/lib/history/union-timeline';",
    ]) {
      expect(IMPORTS_TIMELINE.test(src)).toBe(true);
    }
    expect(IMPORTS_TIMELINE.test("const label = 'union-timeline';")).toBe(false);
  });
});
