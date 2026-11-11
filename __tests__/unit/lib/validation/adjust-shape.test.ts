/**
 * @jest-environment node
 *
 * THE ADJUST REQUEST TRUTH TABLE, pinned whole (reconciliation Part 2, pack
 * CB3a-i.2 + the P2-B3-1 deltas; seam S-B8).
 *
 * `parseAdjustShape` runs on AdjustWithIntentSchema's output — exactly the
 * route's two steps, which is what `shapeOf` below spells — and either returns
 * the request's SHAPE or refuses ONE cell with ONE 400: the field's path and
 * the cell's frozen sentence. The table is TOTAL, so this suite is too:
 *
 *   - every (row, column) cell has an ACCEPTED body — the valid neighbour;
 *   - every frozen sentence has a REFUSED body that produces exactly it, at
 *     exactly its path;
 *   - both are checked for completeness at the bottom, so a cell or a sentence
 *     added to the table without a pin here fails this suite, not a drive.
 *
 * Sentences are spelled as LITERALS here on purpose: importing the constants
 * would let a one-byte wording change pass its own pin.
 *
 * Three things happen BEFORE the table runs and are pinned as such: an
 * explicit `null` meets zod's own message; `delta: 0` meets the base refine's
 * 'Delta must not be zero' (so a correction's "a downward fix is a count" is
 * reachable for `< 0` only); unknown keys — `kind` among them — are stripped.
 */

import { ZodError } from 'zod';
import {
  ADJUST_SHAPE_SENTENCES,
  AdjustWithIntentSchema,
  parseAdjustShape,
  type AdjustShape,
} from '@/lib/validation/inventory';

type Body = Record<string, unknown>;
type Row = 'count' | 'correction' | 'delta';
type Column =
  | 'delta'
  | 'countedQuantity'
  | 'expectedVersion'
  | 'reversesBatchId'
  | 'orderReference'
  | 'selectedExternalOrderId'
  | 'autoAddForTransfer'
  | 'reason/notes'
  | 'logType';

const ROWS: readonly Row[] = ['count', 'correction', 'delta'];
const COLUMNS: readonly Column[] = [
  'delta',
  'countedQuantity',
  'expectedVersion',
  'reversesBatchId',
  'orderReference',
  'selectedExternalOrderId',
  'autoAddForTransfer',
  'reason/notes',
  'logType',
];

const BATCH_ID_UPPER = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const BATCH_ID = BATCH_ID_UPPER.toLowerCase();
const ORDER_ID = 'cmdq7f3k80001s6h4p2n9wxyz';

/** The smallest valid body of each row. */
const COUNT: Body = { productId: 5, locationId: 2, intent: 'count', countedQuantity: 7, expectedVersion: 3 };
const CORRECTION: Body = { productId: 5, locationId: 2, intent: 'correction', delta: 4 };
const DELTA: Body = { productId: 5, locationId: 2, delta: -3 };

/** The delta row's four spellings: the three chip values and an absent chip. */
const DELTA_INTENTS = ['order', 'damage-loss', 'other', undefined] as const;

function without(body: Body, ...keys: string[]): Body {
  const copy = { ...body };
  for (const key of keys) delete copy[key];
  return copy;
}

function deltaBody(intent: (typeof DELTA_INTENTS)[number], over: Body = {}): Body {
  return { ...DELTA, ...(intent !== undefined ? { intent } : {}), ...over };
}

function deltaShape(intent: (typeof DELTA_INTENTS)[number], over: Partial<AdjustShape> = {}) {
  return {
    kind: 'delta',
    productId: 5,
    locationId: 2,
    delta: -3,
    ...(intent !== undefined ? { intent } : {}),
    ...over,
  };
}

/** The schema parse, then the table — the route's own two steps. */
function shapeOf(body: Body): AdjustShape {
  return parseAdjustShape(AdjustWithIntentSchema.parse(body));
}

/** The ONE issue a refused body produces. */
function refusalOf(body: Body): { path: (string | number)[]; message: string } {
  let shape: AdjustShape | undefined;
  try {
    shape = shapeOf(body);
  } catch (err) {
    expect(err).toBeInstanceOf(ZodError);
    const { issues } = err as ZodError;
    expect(issues).toHaveLength(1);
    return { path: issues[0].path, message: issues[0].message };
  }
  throw new Error(`expected a refusal, got ${JSON.stringify(shape)}`);
}

// ---------------------------------------------------------------------------
// THE TABLE, as data
// ---------------------------------------------------------------------------

type Refusal = { row: Row; column: Column; label: string; body: Body; path: string; sentence: string };
type Accept = { row: Row; column: Column; label: string; body: Body; shape: unknown };

const REFUSALS: Refusal[] = [
  // ---- count -------------------------------------------------------------
  { row: 'count', column: 'delta', label: 'a negative delta', body: { ...COUNT, delta: -2 }, path: 'delta', sentence: 'a count carries no delta — send countedQuantity' },
  { row: 'count', column: 'delta', label: 'a positive delta', body: { ...COUNT, delta: 5 }, path: 'delta', sentence: 'a count carries no delta — send countedQuantity' },
  { row: 'count', column: 'countedQuantity', label: 'absent', body: without(COUNT, 'countedQuantity'), path: 'countedQuantity', sentence: 'a count needs the counted quantity' },
  { row: 'count', column: 'expectedVersion', label: 'absent', body: without(COUNT, 'expectedVersion'), path: 'expectedVersion', sentence: 'a count needs the row version it was read at' },
  { row: 'count', column: 'reversesBatchId', label: 'present', body: { ...COUNT, reversesBatchId: BATCH_ID }, path: 'reversesBatchId', sentence: 'a count reverses nothing' },
  { row: 'count', column: 'orderReference', label: 'present', body: { ...COUNT, orderReference: '12345' }, path: 'orderReference', sentence: 'a count is not attributed' },
  { row: 'count', column: 'selectedExternalOrderId', label: 'present', body: { ...COUNT, selectedExternalOrderId: ORDER_ID }, path: 'selectedExternalOrderId', sentence: 'a count is not attributed' },
  { row: 'count', column: 'autoAddForTransfer', label: 'true', body: { ...COUNT, autoAddForTransfer: true }, path: 'autoAddForTransfer', sentence: 'a count is not a transfer' },

  // ---- correction --------------------------------------------------------
  { row: 'correction', column: 'delta', label: 'absent', body: without(CORRECTION, 'delta'), path: 'delta', sentence: 'a correction needs the units to put back' },
  { row: 'correction', column: 'delta', label: 'negative', body: { ...CORRECTION, delta: -2 }, path: 'delta', sentence: 'a downward fix is a count' },
  { row: 'correction', column: 'countedQuantity', label: 'present', body: { ...CORRECTION, countedQuantity: 9 }, path: 'countedQuantity', sentence: 'a correction is not a count' },
  { row: 'correction', column: 'countedQuantity', label: 'present as 0 (defined is present)', body: { ...CORRECTION, countedQuantity: 0 }, path: 'countedQuantity', sentence: 'a correction is not a count' },
  { row: 'correction', column: 'expectedVersion', label: 'present', body: { ...CORRECTION, expectedVersion: 4 }, path: 'expectedVersion', sentence: 'a correction carries no version — the batch lock is its guard' },
  { row: 'correction', column: 'orderReference', label: 'present', body: { ...CORRECTION, orderReference: '12345' }, path: 'orderReference', sentence: 'a correction is attributed by its batch, not a reference' },
  { row: 'correction', column: 'selectedExternalOrderId', label: 'present', body: { ...CORRECTION, selectedExternalOrderId: ORDER_ID }, path: 'selectedExternalOrderId', sentence: 'a correction is attributed by its batch, not a reference' },
  { row: 'correction', column: 'autoAddForTransfer', label: 'true', body: { ...CORRECTION, autoAddForTransfer: true }, path: 'autoAddForTransfer', sentence: 'a correction is not a transfer' },

  // ---- delta, per chip spelling ------------------------------------------
  ...DELTA_INTENTS.flatMap((intent): Refusal[] => [
    { row: 'delta', column: 'delta', label: `absent (${intent ?? 'no chip'})`, body: without(deltaBody(intent), 'delta'), path: 'delta', sentence: 'an adjustment needs the units to add or remove' },
    { row: 'delta', column: 'countedQuantity', label: `present (${intent ?? 'no chip'})`, body: deltaBody(intent, { countedQuantity: 0 }), path: 'countedQuantity', sentence: 'only a count carries a counted quantity' },
    { row: 'delta', column: 'reversesBatchId', label: `present (${intent ?? 'no chip'})`, body: deltaBody(intent, { reversesBatchId: BATCH_ID }), path: 'reversesBatchId', sentence: 'only a correction reverses a batch' },
  ]),
  ...(['damage-loss', 'other', undefined] as const).map((intent): Refusal => ({
    row: 'delta', column: 'orderReference', label: `without the order intent (${intent ?? 'no chip'})`, body: deltaBody(intent, { orderReference: '12345' }), path: 'orderReference', sentence: 'a reference needs the order intent',
  })),
  { row: 'delta', column: 'orderReference', label: 'beside a picked id', body: deltaBody('order', { orderReference: '12345', selectedExternalOrderId: ORDER_ID }), path: 'orderReference', sentence: 'pick the order or type the reference, not both' },
  { row: 'delta', column: 'orderReference', label: 'on a POSITIVE delta (B3-1a delta)', body: deltaBody('order', { delta: 3, orderReference: '12345' }), path: 'orderReference', sentence: 'a reference attributes stock that left — put stock back with a correction' },
];

const ACCEPTS: Accept[] = [
  // ---- count -------------------------------------------------------------
  { row: 'count', column: 'delta', label: 'absent', body: COUNT, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 3 } },
  { row: 'count', column: 'countedQuantity', label: '0 (an empty shelf is a count)', body: { ...COUNT, countedQuantity: 0 }, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 0, expectedVersion: 3 } },
  { row: 'count', column: 'expectedVersion', label: '0 (a never-stocked row)', body: { ...COUNT, expectedVersion: 0 }, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 0 } },
  { row: 'count', column: 'reversesBatchId', label: 'absent', body: COUNT, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 3 } },
  { row: 'count', column: 'orderReference', label: 'absent', body: COUNT, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 3 } },
  { row: 'count', column: 'selectedExternalOrderId', label: 'absent', body: COUNT, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 3 } },
  { row: 'count', column: 'autoAddForTransfer', label: 'false (only `true` refuses; not carried)', body: { ...COUNT, autoAddForTransfer: false }, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 3 } },
  { row: 'count', column: 'reason/notes', label: 'CARRIED (B3-1a delta)', body: { ...COUNT, reason: 'shelf count', notes: 'aisle 3' }, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 3, reason: 'shelf count', notes: 'aisle 3' } },
  { row: 'count', column: 'logType', label: 'ignored', body: { ...COUNT, logType: 'ADJUSTMENT' }, shape: { kind: 'count', productId: 5, locationId: 2, countedQuantity: 7, expectedVersion: 3 } },

  // ---- correction --------------------------------------------------------
  { row: 'correction', column: 'delta', label: 'positive', body: CORRECTION, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },
  { row: 'correction', column: 'countedQuantity', label: 'absent', body: CORRECTION, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },
  { row: 'correction', column: 'expectedVersion', label: 'absent', body: CORRECTION, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },
  { row: 'correction', column: 'reversesBatchId', label: 'present, lowercased (BatchIdParamSchema)', body: { ...CORRECTION, reversesBatchId: BATCH_ID_UPPER }, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4, reversesBatchId: BATCH_ID } },
  { row: 'correction', column: 'reversesBatchId', label: 'absent (an unstamped correction)', body: CORRECTION, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },
  { row: 'correction', column: 'orderReference', label: 'absent', body: CORRECTION, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },
  { row: 'correction', column: 'selectedExternalOrderId', label: 'absent', body: CORRECTION, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },
  { row: 'correction', column: 'autoAddForTransfer', label: 'false', body: { ...CORRECTION, autoAddForTransfer: false }, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },
  { row: 'correction', column: 'reason/notes', label: 'carried', body: { ...CORRECTION, reason: 'double deduction', notes: 'batch 12' }, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4, reason: 'double deduction', notes: 'batch 12' } },
  { row: 'correction', column: 'logType', label: 'ignored', body: { ...CORRECTION, logType: 'ADJUSTMENT' }, shape: { kind: 'correction', productId: 5, locationId: 2, delta: 4 } },

  // ---- delta, per chip spelling ------------------------------------------
  ...DELTA_INTENTS.flatMap((intent): Accept[] => {
    const tag = intent ?? 'no chip';
    return [
      { row: 'delta', column: 'delta', label: `negative (${tag})`, body: deltaBody(intent), shape: deltaShape(intent) },
      { row: 'delta', column: 'delta', label: `positive (${tag})`, body: deltaBody(intent, { delta: 6 }), shape: deltaShape(intent, { delta: 6 }) },
      { row: 'delta', column: 'countedQuantity', label: `absent (${tag})`, body: deltaBody(intent), shape: deltaShape(intent) },
      { row: 'delta', column: 'expectedVersion', label: `optional, carried (${tag})`, body: deltaBody(intent, { expectedVersion: 2 }), shape: deltaShape(intent, { expectedVersion: 2 }) },
      { row: 'delta', column: 'reversesBatchId', label: `absent (${tag})`, body: deltaBody(intent), shape: deltaShape(intent) },
      { row: 'delta', column: 'orderReference', label: `absent (${tag})`, body: deltaBody(intent), shape: deltaShape(intent) },
      // The residual (pack § P2-B3-1): an API-sent id on a POSITIVE delta is
      // accepted as it was before the table — no UI sends one.
      { row: 'delta', column: 'selectedExternalOrderId', label: `optional, either sign (${tag})`, body: deltaBody(intent, { delta: 2, selectedExternalOrderId: ORDER_ID }), shape: deltaShape(intent, { delta: 2, selectedExternalOrderId: ORDER_ID }) },
      { row: 'delta', column: 'selectedExternalOrderId', label: `optional, a removal (${tag})`, body: deltaBody(intent, { selectedExternalOrderId: ORDER_ID }), shape: deltaShape(intent, { selectedExternalOrderId: ORDER_ID }) },
      { row: 'delta', column: 'autoAddForTransfer', label: `true on an add (${tag})`, body: deltaBody(intent, { delta: 4, autoAddForTransfer: true }), shape: deltaShape(intent, { delta: 4, autoAddForTransfer: true }) },
      // `true` on a REMOVAL passes the PARSE: its refusal is the route's own
      // 400, behind this table (pinned in w2-intent-chip.test.ts, "REFUSES a
      // NEGATIVE delta carrying autoAddForTransfer").
      { row: 'delta', column: 'autoAddForTransfer', label: `true on a removal reaches the route's own 400 (${tag})`, body: deltaBody(intent, { autoAddForTransfer: true }), shape: deltaShape(intent, { autoAddForTransfer: true }) },
      { row: 'delta', column: 'reason/notes', label: `carried (${tag})`, body: deltaBody(intent, { reason: 'dropped', notes: 'n' }), shape: deltaShape(intent, { reason: 'dropped', notes: 'n' }) },
      { row: 'delta', column: 'logType', label: `ignored (${tag})`, body: deltaBody(intent, { logType: 'ADJUSTMENT' }), shape: deltaShape(intent) },
    ];
  }),
  { row: 'delta', column: 'orderReference', label: 'order + a removal, trimmed', body: deltaBody('order', { orderReference: '  12345  ' }), shape: deltaShape('order', { orderReference: '12345' }) },
];

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

describe('parseAdjustShape — every refusal cell: its path and its frozen sentence', () => {
  it.each(REFUSALS.map((r) => [`${r.row} · ${r.column} · ${r.label}`, r] as const))(
    '%s',
    (_title, r) => {
      // The schema alone accepts it: this is the TABLE refusing, not zod.
      expect(AdjustWithIntentSchema.safeParse(r.body).success).toBe(true);
      expect(refusalOf(r.body)).toEqual({ path: [r.path], message: r.sentence });
    },
  );
});

describe('parseAdjustShape — every cell\'s valid neighbour: the exact shape', () => {
  it.each(ACCEPTS.map((a) => [`${a.row} · ${a.column} · ${a.label}`, a] as const))(
    '%s',
    (_title, a) => {
      // Strict: an optional key the request did not send is ABSENT, never
      // `undefined`-valued.
      expect(shapeOf(a.body)).toStrictEqual(a.shape);
    },
  );
});

describe('parseAdjustShape — the kind, derived from intent (server-side only)', () => {
  it.each([
    ['order', 'delta'],
    ['damage-loss', 'delta'],
    ['other', 'delta'],
    [undefined, 'delta'],
  ] as const)('intent %s -> %s', (intent, kind) => {
    expect(shapeOf(deltaBody(intent)).kind).toBe(kind);
  });

  it('intent count -> count; intent correction -> correction', () => {
    expect(shapeOf(COUNT).kind).toBe('count');
    expect(shapeOf(CORRECTION).kind).toBe('correction');
  });

  it('a `kind` sent on the wire is stripped by zod and never read', () => {
    expect(shapeOf({ ...DELTA, kind: 'count' }).kind).toBe('delta');
    expect(shapeOf({ ...COUNT, kind: 'delta' }).kind).toBe('count');
  });
});

describe('BEFORE the table: zod answers first', () => {
  it.each([
    ['a count\'s delta', { ...COUNT, delta: null }, 'delta', 'Expected number, received null'],
    ['countedQuantity', { ...COUNT, countedQuantity: null }, 'countedQuantity', 'Expected number, received null'],
    ['expectedVersion', { ...COUNT, expectedVersion: null }, 'expectedVersion', 'Expected number, received null'],
    ['reversesBatchId', { ...CORRECTION, reversesBatchId: null }, 'reversesBatchId', 'Expected string, received null'],
    ['orderReference', deltaBody('order', { orderReference: null }), 'orderReference', 'Expected string, received null'],
    ['selectedExternalOrderId', { ...DELTA, selectedExternalOrderId: null }, 'selectedExternalOrderId', 'Expected string, received null'],
    ['autoAddForTransfer', { ...DELTA, autoAddForTransfer: null }, 'autoAddForTransfer', 'Expected boolean, received null'],
  ])('an explicit null %s meets zod\'s own message, not a table sentence', (_label, body, path, message) => {
    expect(AdjustWithIntentSchema.safeParse(body).success).toBe(false);
    expect(refusalOf(body)).toEqual({ path: [path], message });
  });

  it('correction + delta: 0 meets the base refine (\'Delta must not be zero\') first', () => {
    expect(refusalOf({ ...CORRECTION, delta: 0 })).toEqual({
      path: ['delta'],
      message: 'Delta must not be zero',
    });
  });

  it('a delta-row delta of 0 is today\'s refine, for every chip spelling', () => {
    for (const intent of DELTA_INTENTS) {
      expect(refusalOf(deltaBody(intent, { delta: 0 }))).toEqual({
        path: ['delta'],
        message: 'Delta must not be zero',
      });
    }
  });

  it('the reference field\'s bounds: trimmed, non-empty, at most 40', () => {
    expect(refusalOf(deltaBody('order', { orderReference: '   ' }))).toEqual({
      path: ['orderReference'],
      message: 'String must contain at least 1 character(s)',
    });
    expect(refusalOf(deltaBody('order', { orderReference: '1'.repeat(41) }))).toEqual({
      path: ['orderReference'],
      message: 'String must contain at most 40 character(s)',
    });
    expect(shapeOf(deltaBody('order', { orderReference: '1'.repeat(40) }))).toMatchObject({
      orderReference: '1'.repeat(40),
    });
  });

  it('reversesBatchId is the batch-id guard (a uuid), and countedQuantity a non-negative integer', () => {
    expect(refusalOf({ ...CORRECTION, reversesBatchId: 'not-a-uuid' })).toEqual({
      path: ['reversesBatchId'],
      message: 'Invalid uuid',
    });
    expect(AdjustWithIntentSchema.safeParse({ ...COUNT, countedQuantity: -1 }).success).toBe(false);
    expect(AdjustWithIntentSchema.safeParse({ ...COUNT, countedQuantity: 1.5 }).success).toBe(false);
  });
});

describe('one body, several broken cells: the leftmost column\'s sentence wins', () => {
  // The order: delta, countedQuantity, expectedVersion, reversesBatchId,
  // orderReference, selectedExternalOrderId, autoAddForTransfer — and inside
  // the delta row's orderReference cell: the order intent, then id-and-
  // reference, then a positive delta.
  it.each([
    [
      'count: a delta AND no counted quantity AND no version AND a reference AND auto-add',
      { productId: 5, locationId: 2, intent: 'count', delta: 5, orderReference: '12', autoAddForTransfer: true },
      'delta',
      'a count carries no delta — send countedQuantity',
    ],
    [
      'count: no counted quantity AND no version AND a batch',
      { productId: 5, locationId: 2, intent: 'count', reversesBatchId: BATCH_ID },
      'countedQuantity',
      'a count needs the counted quantity',
    ],
    [
      'correction: downward AND a version AND a picked id',
      { ...CORRECTION, delta: -2, expectedVersion: 1, selectedExternalOrderId: ORDER_ID },
      'delta',
      'a downward fix is a count',
    ],
    [
      'correction: a reference AND a picked id AND auto-add',
      { ...CORRECTION, orderReference: '12', selectedExternalOrderId: ORDER_ID, autoAddForTransfer: true },
      'orderReference',
      'a correction is attributed by its batch, not a reference',
    ],
    [
      'delta: no delta AND a counted quantity',
      { productId: 5, locationId: 2, countedQuantity: 1 },
      'delta',
      'an adjustment needs the units to add or remove',
    ],
    [
      'delta: a counted quantity AND a batch AND a reference under `other`',
      { ...DELTA, intent: 'other', countedQuantity: 1, reversesBatchId: BATCH_ID, orderReference: '12' },
      'countedQuantity',
      'only a count carries a counted quantity',
    ],
    [
      'delta: a batch AND a reference under `other`',
      { ...DELTA, intent: 'other', reversesBatchId: BATCH_ID, orderReference: '12' },
      'reversesBatchId',
      'only a correction reverses a batch',
    ],
    [
      'delta: a reference under `other` AND a picked id AND a positive delta',
      { ...DELTA, intent: 'other', delta: 3, orderReference: '12', selectedExternalOrderId: ORDER_ID },
      'orderReference',
      'a reference needs the order intent',
    ],
    [
      'delta: `order` + a reference AND a picked id AND a positive delta',
      { ...DELTA, intent: 'order', delta: 3, orderReference: '12', selectedExternalOrderId: ORDER_ID },
      'orderReference',
      'pick the order or type the reference, not both',
    ],
  ])('%s -> %s', (_label, body, path, sentence) => {
    expect(refusalOf(body)).toEqual({ path: [path], message: sentence });
  });
});

describe('the table is TOTAL', () => {
  it('every (row, column) cell has a valid neighbour pinned above', () => {
    const missing = ROWS.flatMap((row) =>
      COLUMNS.filter((column) => !ACCEPTS.some((a) => a.row === row && a.column === column)).map(
        (column) => `${row} · ${column}`,
      ),
    );
    expect(missing).toEqual([]);
  });

  it('every frozen sentence is produced by a refusal pinned above, and no other sentence is', () => {
    const pinned = REFUSALS.map((r) => r.sentence).filter((s, i, all) => all.indexOf(s) === i);
    expect(pinned.sort()).toEqual(Object.values(ADJUST_SHAPE_SENTENCES).sort());
  });

  it('the delta row runs for every chip spelling (order / damage-loss / other / absent)', () => {
    for (const intent of DELTA_INTENTS) {
      expect(REFUSALS.some((r) => r.row === 'delta' && r.body.intent === intent)).toBe(true);
      expect(ACCEPTS.some((a) => a.row === 'delta' && a.body.intent === intent)).toBe(true);
    }
  });
});
