/**
 * THE EXCEPTIONS FINDER (reconciliation lane, spec REV-7 §4.3 / D5 / D7; pack
 * C2c.1). Part 1 is a FINDER, not a register (SETTLED 10): it filters, ages and
 * deep-links the rows `inventory_exceptions` already carries, and it writes
 * nothing. The surfaces that RESOLVE these rows already exist, and this tab's
 * job is to get a human to the right one.
 *
 * THIS MODULE OWNS THE DELEGATE for the lane's reads (pack R-5). The exceptions
 * GET route may not so much as spell the delegate's name — the boundary gate
 * (`__tests__/integration/exceptions-write-boundary.test.ts`) fails any GET
 * segment that mentions it, comments included — so the route calls
 * `listExceptions` and the Overview calls `countOpenExceptions`, and the one
 * place that names the table is this file.
 *
 * A CLOSED RENDERER TABLE, NOT A UI DECISION (OCp-14). Four of the seven kinds
 * carry a subject shape; three have no writer yet. Rather than let the tab
 * discover that at render time, every kind gets a renderer HERE — a sentence, a
 * money decision and a link decision — as `Record<ExceptionKind, Renderer>`, so
 * adding a kind to the vocabulary without deciding how it reads is a compile
 * error rather than a blank cell. The three unwritten kinds render defensively
 * and say so; so does any row whose subject cannot be read, because a finder
 * that throws on one malformed row shows nobody the other two hundred.
 *
 * TRUTHFUL BOUNDS (R-2/D7). `severity` is translated to a `kind IN (…)`
 * predicate at QUERY time, never filtered out of a page afterwards: a count
 * computed over rows a post-filter later dropped is a number nobody can stand
 * behind. `moreCount` is `count - consumed - rowsReturned`, and the cursor
 * carries `consumed`, so the bound is exact on every page.
 *
 * Next-free by contract.
 */

import type { Prisma } from '@prisma/client';
import { StagingItemStatus } from '@prisma/client';
import prisma from '@/lib/prisma';
import { AppError } from '@/lib/error-handling';
import {
  EXCEPTION_SEVERITY,
  type ExceptionKind,
  type ExceptionSeverity,
} from '@/lib/exceptions/kinds';
import { RECONCILIATION_USER_SELECT } from './pii';

export type { ExceptionSeverity } from '@/lib/exceptions/kinds';

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/** Money, or the NAMED reason there is none — never a 0 standing in for both. */
export type ExceptionMoney = { cents: number; label: string } | { cents: null; reason: string };

/** Where this row is settled, or the reason there is nowhere to go. */
export type ExceptionLink =
  | { href: string; label: string; warning?: string }
  | { href: null; copy: string };

export type ExceptionRowView = {
  id: number;
  key: string;
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  subjectSummary: string;
  money: ExceptionMoney;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Days since `lastSeenAt` — the SAME axis `olderThanDays` filters on. */
  ageDays: number;
  resolvedAt: string | null;
  resolvedBy: { id: number; username: string } | null;
  resolution: string | null;
  note: string | null;
  link: ExceptionLink;
};

export type ExceptionsInput = {
  kind?: ExceptionKind;
  /** Defaults to `open` — the half somebody still has to do something about. */
  resolved?: 'open' | 'resolved' | 'all';
  severity?: ExceptionSeverity;
  olderThanDays?: number;
  /** At most 200 — the route refuses more. */
  limit: number;
  /** Opaque: base64url of `{ t, i, c }` (lastSeenAt ms, id, consumed). */
  cursor?: string;
};

export type ExceptionsPage = {
  rows: ExceptionRowView[];
  count: number;
  moreCount: number;
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// The renderer table (pack C2c.1)
// ---------------------------------------------------------------------------

/**
 * `fmt` — the `components/analytics/supply-orders-card.tsx` `usd` idiom, kept
 * module-local. Money is formatted in ONE place per surface; a second spelling
 * is how "$19.99" and "19.99 USD" end up on the same screen.
 */
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const usd = (cents: number): string => fmt.format(cents / 100);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** What the removed-line rule needs to know about the page's rows. */
type LinkContext = { removedLines: ReadonlySet<number> };

type Renderer = {
  /** `null` = this subject cannot be read; the defensive sentence takes over. */
  summary: (subject: Record<string, unknown>) => string | null;
  money: (subject: Record<string, unknown>) => ExceptionMoney;
  link: (subject: Record<string, unknown>, ctx: LinkContext) => ExceptionLink;
};

const NOT_PRICED: ExceptionMoney = { cents: null, reason: 'Not priced' };

/**
 * The receiving deep link (spec D5): the line, on the order that carries it.
 *
 * THREE outcomes, in this order. A DISCARDED line comes first — the row can
 * outlive the line it names (an unordered arrival removed as a duplicate), and
 * sending somebody to a line that is not there is worse than saying so. Then
 * the link. Then the honest refusal for a subject whose shipment id was never
 * recorded, which is a real historical shape, not a bug.
 */
function receivingLink(subject: Record<string, unknown>, ctx: LinkContext): ExceptionLink {
  const stagingItemId = num(subject.stagingItemId);
  if (stagingItemId !== null && ctx.removedLines.has(stagingItemId)) {
    return { href: null, copy: 'removed line' };
  }
  const shipmentId = str(subject.shipmentId);
  if (shipmentId === null || stagingItemId === null) {
    return { href: null, copy: "no order to open (the line's order id was not recorded)" };
  }
  return { href: `/receiving/${shipmentId}?line=${stagingItemId}`, label: 'Open the order line' };
}

/**
 * The three kinds W3 declared and nobody writes yet (OCk-9). They render their
 * own absence — including the subject's raw key names, which is what somebody
 * debugging a hand-written row actually needs — and never a fabricated summary.
 */
const UNWRITTEN_RENDERER: Renderer = {
  summary: () => null,
  money: () => ({ cents: null, reason: 'no money renderer for this kind yet' }),
  link: () => ({ href: null, copy: 'no destination yet (Part 2)' }),
};

/**
 * CLOSED: one renderer per kind. `Record<ExceptionKind, Renderer>` is the point
 * — a kind added to the vocabulary without a renderer does not compile.
 */
const RENDERERS: Record<ExceptionKind, Renderer> = {
  'recv-discrepancy': {
    summary: (s) => {
      const countedQty = num(s.countedQty);
      if (countedQty === null) return null;
      const expectedQty = num(s.expectedQty);
      const shortUnits = num(s.shortUnits);
      const overUnits = num(s.overUnits);
      return (
        `${countedQty} counted vs ${expectedQty ?? 'no order'} expected` +
        `${shortUnits ? ` — ${shortUnits} short` : ''}${overUnits ? ` — ${overUnits} over` : ''}`
      );
    },
    // `lossCents`/`surplusValueCents` are ALWAYS real numbers on this subject
    // (lib/supply-orders/money.ts writes 0 for "not short" AND for "unpriced"),
    // so a zero here means "no money to report", not "this cost nothing".
    money: (s) => {
      const loss = num(s.lossCents);
      if (loss) return { cents: loss, label: 'supplier shortage' };
      const surplus = num(s.surplusValueCents);
      if (surplus) return { cents: surplus, label: 'surplus value' };
      return NOT_PRICED;
    },
    link: receivingLink,
  },
  'labeling-loss': {
    summary: (s) => {
      const units = num(s.units);
      const reason = str(s.reason);
      if (units === null || reason === null) return null;
      return `${units} unit(s) lost at labeling — ${reason}`;
    },
    // Here `lossCents` is NULLABLE by design: null is "what these units cost is
    // unknown" and a real 0 is a KNOWN zero (kinds.ts LabelingLossSubject), so
    // this one reads the type rather than the truthiness.
    money: (s) => {
      const loss = num(s.lossCents);
      return loss === null ? NOT_PRICED : { cents: loss, label: 'labeling loss' };
    },
    link: receivingLink,
  },
  'pending-with-stock': {
    summary: (s) => {
      const units = num(s.units);
      return units === null ? null : `${units} unit(s) stocked against a pending product`;
    },
    money: () => ({ cents: null, reason: 'no money on this kind' }),
    link: () => ({ href: '/admin/product-review', label: 'Open product review' }),
  },
  'cost-differs': {
    summary: (s) => {
      const receiptCents = num(s.receiptCents);
      if (receiptCents === null) return null;
      const currentCents = num(s.currentCents);
      return `receipt ${usd(receiptCents)} vs standing ${
        currentCents === null ? 'unset' : usd(currentCents)
      }`;
    },
    money: () => ({
      cents: null,
      reason: "settled by the admin's cost decision — resolution semantics registered",
    }),
    link: () => ({ href: null, copy: 'read-only in Part 1' }),
  },
  'unattributed-outstock': UNWRITTEN_RENDERER,
  'unmapped-lines': UNWRITTEN_RENDERER,
  'gap-order': UNWRITTEN_RENDERER,
};

/**
 * What a row says when its subject cannot be read — on ANY kind, including the
 * four with renderers. The raw key names ride along because they are the one
 * fact that tells a reader whether the row is old, hand-written, or a shape
 * nobody has taught this module yet.
 */
function defensiveSummary(kind: string, subject: unknown): string {
  const keys = isObj(subject) ? Object.keys(subject) : null;
  return keys
    ? `(${kind}) — no summary renderer yet; raw subject keys: ${keys.join(', ') || 'none'}`
    : `(${kind}) — no summary renderer yet; subject is not an object`;
}

// ---------------------------------------------------------------------------
// Bounds and cursors
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

type Cursor = { t: number; i: number; c: number };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Opaque in, validated out — a cursor somebody edited is a 400, never page 1. */
function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('invalid cursor', 'VALIDATION_ERROR', 400);
  }
  if (
    !isObj(parsed) ||
    typeof parsed.t !== 'number' ||
    !Number.isFinite(parsed.t) ||
    typeof parsed.i !== 'number' ||
    !Number.isInteger(parsed.i) ||
    typeof parsed.c !== 'number' ||
    !Number.isFinite(parsed.c) ||
    parsed.c < 0
  ) {
    throw new AppError('invalid cursor', 'VALIDATION_ERROR', 400);
  }
  return { t: parsed.t, i: parsed.i, c: parsed.c };
}

/**
 * The kinds that carry a severity, IN MAP ORDER. The map is closed, so this is
 * a total translation of a severity filter into a predicate the index can serve
 * — which is the whole reason severity never becomes a post-filter.
 */
function kindsWithSeverity(severity: ExceptionSeverity): ExceptionKind[] {
  return (Object.entries(EXCEPTION_SEVERITY) as Array<[ExceptionKind, ExceptionSeverity]>)
    .filter(([, value]) => value === severity)
    .map(([kind]) => kind);
}

/**
 * The filter half of the read. Deliberately shared by the count and the page:
 * the count is of the WHOLE filtered set, and the keyset is added to the page
 * read alone, so `count` never depends on which page you are looking at.
 */
function buildWhere(input: ExceptionsInput, now: Date): Prisma.InventoryExceptionWhereInput {
  const where: Prisma.InventoryExceptionWhereInput = {};

  const resolved = input.resolved ?? 'open';
  if (resolved === 'open') where.resolvedAt = null;
  else if (resolved === 'resolved') where.resolvedAt = { not: null };

  if (input.severity !== undefined) {
    const kinds = kindsWithSeverity(input.severity);
    if (input.kind !== undefined) {
      // Both filters, honoured together: a kind that does not carry the asked-for
      // severity matches NOTHING. Silently dropping one of the two would answer a
      // question nobody asked.
      where.kind = kinds.includes(input.kind) ? input.kind : { in: [] };
    } else {
      where.kind = { in: kinds };
    }
  } else if (input.kind !== undefined) {
    where.kind = input.kind;
  }

  if (input.olderThanDays !== undefined) {
    where.lastSeenAt = { lte: new Date(now.getTime() - input.olderThanDays * DAY_MS) };
  }

  return where;
}

// ---------------------------------------------------------------------------
// THE FINDER
// ---------------------------------------------------------------------------

export async function listExceptions(input: ExceptionsInput): Promise<ExceptionsPage> {
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const now = new Date();
  const where = buildWhere(input, now);

  const pageWhere: Prisma.InventoryExceptionWhereInput =
    cursor === null
      ? where
      : {
          ...where,
          OR: [
            { lastSeenAt: { lt: new Date(cursor.t) } },
            { lastSeenAt: new Date(cursor.t), id: { lt: cursor.i } },
          ],
        };

  const [count, rows] = await prisma.$transaction([
    prisma.inventoryException.count({ where }),
    prisma.inventoryException.findMany({
      where: pageWhere,
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      select: {
        id: true,
        key: true,
        kind: true,
        subject: true,
        firstSeenAt: true,
        lastSeenAt: true,
        resolvedAt: true,
        resolvedBy: true,
        resolution: true,
        note: true,
      },
    }),
  ]);

  const [removedLines, resolvers] = await Promise.all([
    loadRemovedLines(rows.map((row) => row.subject)),
    loadResolvers(rows.map((row) => row.resolvedBy)),
  ]);

  const views = rows.map((row) => buildRowView(row, now, { removedLines }, resolvers));
  const consumed = cursor?.c ?? 0;
  const moreCount = Math.max(count - consumed - views.length, 0);
  const last = rows[rows.length - 1];

  return {
    rows: views,
    count,
    moreCount,
    nextCursor:
      moreCount > 0 && last !== undefined
        ? encodeCursor({ t: last.lastSeenAt.getTime(), i: last.id, c: consumed + views.length })
        : null,
  };
}

/**
 * The Overview's counter (pack C2c.3). It lives HERE because the delegate does:
 * `overview.ts` sits behind an ops-health GET segment, where the boundary gate
 * forbids the word.
 */
export async function countOpenExceptions(): Promise<number> {
  return prisma.inventoryException.count({ where: { resolvedAt: null } });
}

// ---------------------------------------------------------------------------
// Page-local lookups (one statement each, never one per row)
// ---------------------------------------------------------------------------

type StoredRow = {
  id: number;
  key: string;
  kind: string;
  subject: Prisma.JsonValue;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolvedBy: number | null;
  resolution: string | null;
  note: string | null;
};

/**
 * Which of the page's lines have been REMOVED from their order. One `IN` over
 * the page's staging ids, asking only about the status that changes what a row
 * says — a page whose subjects name no line asks nothing at all.
 */
async function loadRemovedLines(subjects: Prisma.JsonValue[]): Promise<ReadonlySet<number>> {
  const ids = Array.from(
    new Set(
      subjects
        .map((subject) => (isObj(subject) ? num(subject.stagingItemId) : null))
        .filter((id): id is number => id !== null),
    ),
  );
  if (ids.length === 0) return new Set();
  const lines = await prisma.stagingItem.findMany({
    where: { id: { in: ids }, status: StagingItemStatus.DISCARDED },
    select: { id: true },
  });
  return new Set(lines.map((line) => line.id));
}

/**
 * Who settled these rows. `resolvedBy` is a bare `Int?` with no relation, so
 * identity is ONE batched lookup per page (OCk-7) — and a page of open rows
 * never asks.
 */
async function loadResolvers(
  ids: Array<number | null>,
): Promise<Map<number, { id: number; username: string }>> {
  const map = new Map<number, { id: number; username: string }>();
  const wanted = Array.from(new Set(ids.filter((id): id is number => id !== null)));
  if (wanted.length === 0) return map;
  const users = await prisma.user.findMany({
    where: { id: { in: wanted } },
    select: RECONCILIATION_USER_SELECT,
  });
  for (const user of users) map.set(user.id, { id: user.id, username: user.username });
  return map;
}

// ---------------------------------------------------------------------------
// Row -> view
// ---------------------------------------------------------------------------

function buildRowView(
  row: StoredRow,
  now: Date,
  ctx: LinkContext,
  resolvers: Map<number, { id: number; username: string }>,
): ExceptionRowView {
  // A kind outside the closed vocabulary can only come from a hand-written row
  // (one writer, one closed type). It renders defensively and at the LOWEST
  // severity: nobody has triaged it, and a fabricated `high` would page someone
  // about a shape no code writes.
  const renderer = RENDERERS[row.kind as ExceptionKind] ?? UNWRITTEN_RENDERER;
  const severity = EXCEPTION_SEVERITY[row.kind as ExceptionKind] ?? 'low';
  const subject = isObj(row.subject) ? row.subject : {};
  const summary = isObj(row.subject) ? renderer.summary(subject) : null;

  return {
    id: row.id,
    key: row.key,
    kind: row.kind as ExceptionKind,
    severity,
    subjectSummary: summary ?? defensiveSummary(row.kind, row.subject),
    money: renderer.money(subject),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    ageDays: Math.floor((now.getTime() - row.lastSeenAt.getTime()) / DAY_MS),
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    resolvedBy: row.resolvedBy === null ? null : (resolvers.get(row.resolvedBy) ?? null),
    resolution: row.resolution,
    note: row.note,
    link: renderer.link(subject, ctx),
  };
}
