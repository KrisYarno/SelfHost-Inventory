// @jest-environment node
//
// Reconciliation lane R-B (spec REV-7 §2.0, pack C2a.1) — THE POPULATION.
//
// Two things are pinned here and they are pinned for different reasons.
//
// ONE HOME, TWO RENDERERS (plan P-4). `logType IN (SALE, ADJUSTMENT) AND
// delta < 0 AND batchId IS NOT NULL` is spelled ONCE, as a data table, and both
// the Prisma `where` and the raw SQL fragment are RENDERED from it. "Both
// renderers say the same thing" is not a comment anyone can trust — so the
// mutate-a-copy test below renders a CHANGED table through both renderers and
// asserts both outputs moved. If a renderer ever hard-codes its own copy of the
// predicate, that test is the one that fails.
//
// R0 PARITY. The mass-update discriminator is NOT re-derived here: the
// diagnostics module (scripts/diagnostics/inventory-accuracy/lib/mass-update.js)
// is the frozen historical rule, and this module carries a VERBATIM TS port of
// it. The parity table below runs BOTH implementations over the same fixtures
// and asserts they agree on every field — a port that drifts is a port that
// silently re-labels pre-0b-1 mass-update sessions as attributable deductions.
//
// The JS original is IMPORTED rather than `require`d: the repo's eslint forbids
// require-style imports in TS (@typescript-eslint/no-require-imports) and this
// milestone's exit gate is a byte-identical lint run. Same module, same code.
import fs from 'fs';
import path from 'path';

import { classifyMassUpdateBatch as classifyMassUpdateBatchJs } from '../../../../scripts/diagnostics/inventory-accuracy/lib/mass-update.js';

import {
  ATTRIBUTABLE_DEFINITION,
  ATTRIBUTABLE_PREDICATE,
  classifyMassUpdateBatch,
  deductedSideSql,
  isAttributableBatch,
  renderRowWhere,
  renderRowWhereSql,
  rowWhere,
  rowWhereSql,
  type PopulationAuditEvent,
  type PopulationPredicate,
} from '@/lib/reconciliation/population';

describe('ATTRIBUTABLE_PREDICATE — the one home', () => {
  it('is the frozen three-fact table', () => {
    expect(ATTRIBUTABLE_PREDICATE).toEqual({
      logTypes: ['SALE', 'ADJUSTMENT'],
      deltaBelow: 0,
      batchIdRequired: true,
    });
    expect(Object.isFrozen(ATTRIBUTABLE_PREDICATE)).toBe(true);
  });

  it('carries the definition string verbatim (it rides to the report header)', () => {
    expect(ATTRIBUTABLE_DEFINITION).toBe(
      'a SUBSET of physical outbound (isPhysicalOutboundRow in metrics-contract includes COUNT/CORRECTION; this population is SALE/ADJUSTMENT deducts with a batch id), grouped by batchId, minus older mass-update sessions (R0)'
    );
  });
});

describe('rowWhere — the Prisma renderer', () => {
  it('deep-equals the literal every read in this lane uses', () => {
    expect(rowWhere).toEqual({
      logType: { in: ['SALE', 'ADJUSTMENT'] },
      delta: { lt: 0 },
      batchId: { not: null },
    });
  });
});

describe('rowWhereSql — the raw renderer', () => {
  it('renders exactly the three conjuncts over the requested alias', () => {
    expect(rowWhereSql('l').sql).toBe(
      'l.logType IN (?,?) AND l.delta < 0 AND l.batchId IS NOT NULL'
    );
  });

  it('carries the two log types as bound values (never inlined strings)', () => {
    expect(rowWhereSql('l').values).toEqual(['SALE', 'ADJUSTMENT']);
  });

  it('defaults to alias `l` (inventory_logs l — the shape the totals CTE uses)', () => {
    expect(rowWhereSql().sql).toBe(rowWhereSql('l').sql);
  });

  it('renders any alias the caller names', () => {
    expect(rowWhereSql('logs').sql).toBe(
      'logs.logType IN (?,?) AND logs.delta < 0 AND logs.batchId IS NOT NULL'
    );
  });

  it('refuses an alias that is not a bare SQL identifier (it is interpolated RAW)', () => {
    expect(() => rowWhereSql('l; DROP TABLE inventory_logs --')).toThrow(/alias/i);
    expect(() => rowWhereSql('')).toThrow(/alias/i);
  });
});

describe('both renderers are RENDERED from the predicate table (plan P-4)', () => {
  // A copy with every field changed. If either renderer carried its own hard-coded
  // copy of the predicate, its output here would be identical to the frozen one.
  const mutated: PopulationPredicate = {
    logTypes: ['CORRECTION'],
    deltaBelow: -5,
    batchIdRequired: false,
  };

  it('the Prisma renderer follows the table', () => {
    expect(renderRowWhere(mutated)).toEqual({
      logType: { in: ['CORRECTION'] },
      delta: { lt: -5 },
    });
    expect(renderRowWhere(mutated)).not.toEqual(rowWhere);
  });

  it('the raw renderer follows the table', () => {
    expect(renderRowWhereSql(mutated, 'l').sql).toBe('l.logType IN (?) AND l.delta < -5');
    expect(renderRowWhereSql(mutated, 'l').values).toEqual(['CORRECTION']);
    expect(renderRowWhereSql(mutated, 'l').sql).not.toBe(rowWhereSql('l').sql);
  });

  it('the frozen table renders the frozen fragments', () => {
    expect(renderRowWhere(ATTRIBUTABLE_PREDICATE)).toEqual(rowWhere);
    expect(renderRowWhereSql(ATTRIBUTABLE_PREDICATE, 'l').sql).toBe(rowWhereSql('l').sql);
  });

  it('spells the log types exactly ONCE each outside the ported rule (R-3)', () => {
    // The behavioural pins above cannot see a renderer that carries its own
    // hard-coded copy of the predicate while that copy still AGREES with the
    // table — the drift only shows up on the day someone edits the table. So the
    // source is scanned: 'SALE' may appear twice (the table, and `hasSale` in the
    // verbatim port of the diagnostics rule) and 'ADJUSTMENT' exactly once. A
    // second spelling of the predicate anywhere in this module fails here.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../../lib/reconciliation/population.ts'),
      'utf8'
    );
    expect(src.match(/'SALE'/g) ?? []).toHaveLength(2);
    expect(src.match(/'ADJUSTMENT'/g) ?? []).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE DEDUCTED SIDE (Part 2, pack CA1.5) — the aggregate builder.
//
// The matcher's other side. It is rendered HERE, beside the population, for the
// same reason the two renderers above are: `out` is "what the population took
// out for this order", and a builder that re-spelled the predicate would be a
// second definition of the population wearing an aggregate's clothes.
// ---------------------------------------------------------------------------

describe('deductedSideSql — ONE plain mode, the population rendered through rowWhereSql', () => {
  const flatten = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  it('renders both CASE arms, the bound ids and the GROUP BY, verbatim', () => {
    const built = deductedSideSql(['o1', 'o2']);
    expect(flatten(built.sql)).toBe(
      'SELECT l.orderRecordId AS orderRecordId, l.productId AS productId, ' +
        'COALESCE(SUM(CASE WHEN l.logType IN (?,?) AND l.delta < 0 AND l.batchId IS NOT NULL ' +
        'THEN -l.delta ELSE 0 END), 0) AS outUnits, ' +
        "COALESCE(SUM(CASE WHEN l.logType = 'CORRECTION' AND l.delta > 0 THEN l.delta ELSE 0 END), 0) " +
        'AS correctedUnits ' +
        'FROM inventory_logs l ' +
        'WHERE l.orderRecordId IN (?,?) AND ((l.logType IN (?,?) AND l.delta < 0 AND l.batchId IS NOT NULL) ' +
        "OR (l.logType = 'CORRECTION' AND l.delta > 0)) " +
        'GROUP BY l.orderRecordId, l.productId'
    );
  });

  it('BINDS the order ids (never interpolates them) and the log types with them', () => {
    expect(deductedSideSql(['o1', 'o2']).values).toEqual([
      'SALE',
      'ADJUSTMENT',
      'o1',
      'o2',
      'SALE',
      'ADJUSTMENT',
    ]);
    expect(deductedSideSql(["o'1"]).sql).not.toContain("o'1");
  });

  it('renders the population conjuncts FROM rowWhereSql, twice, never re-spelled', () => {
    const fragment = rowWhereSql('l').sql;
    const built = flatten(deductedSideSql(['o1']).sql);
    expect(built.split(fragment)).toHaveLength(3); // two occurrences
  });

  it('follows the predicate TABLE — a mutated table renders a fragment this builder does not carry', () => {
    // The builder takes no predicate parameter (there is one population), so the
    // mutate-through is asserted from the other side: what a CHANGED table
    // renders is exactly what the builder must NOT contain, while what the
    // frozen table renders is what it must.
    const mutated: PopulationPredicate = {
      logTypes: ['CORRECTION'],
      deltaBelow: -5,
      batchIdRequired: false,
    };
    const built = flatten(deductedSideSql(['o1']).sql);
    expect(built).toContain(renderRowWhereSql(ATTRIBUTABLE_PREDICATE, 'l').sql);
    expect(built).not.toContain(renderRowWhereSql(mutated, 'l').sql);
  });

  it('TRANSFER legs enter neither side by construction', () => {
    // Not in the population (logType IN (SALE, ADJUSTMENT)), and not a positive
    // CORRECTION. Nothing to filter out: there is no TRANSFER token at all.
    expect(deductedSideSql(['o1']).sql).not.toContain('TRANSFER');
  });

  it('refuses an EMPTY id list (it would render IN ()) and more than 200', () => {
    expect(() => deductedSideSql([])).toThrow(RangeError);
    expect(() => deductedSideSql([])).toThrow(/at least one order/);
    const ids = Array.from({ length: 201 }, (_, i) => `o${i}`);
    expect(() => deductedSideSql(ids)).toThrow(RangeError);
    expect(() => deductedSideSql(ids)).toThrow(/at most 200 orders/);
    expect(() => deductedSideSql(ids.slice(0, 200))).not.toThrow();
  });

  it('the module STILL carries no Prisma write token (the aggregate is a read)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../../lib/reconciliation/population.ts'),
      'utf8'
    );
    const re =
      /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$(executeRaw|executeRawUnsafe|queryRawUnsafe)\b/g;
    expect(src.match(re)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R0 — the parity table. Every row runs through BOTH implementations.
// ---------------------------------------------------------------------------

type ParityRow = {
  name: string;
  rows: Array<{ logType: string }>;
  auditEvents: PopulationAuditEvent[];
  attributable: boolean;
};

/** The adapter the module builds internally, rebuilt here to feed the JS original. */
function jsInput(row: ParityRow) {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return {
    auditActionTypes: new Set(row.auditEvents.map((e) => e.actionType)),
    logTypes: new Set(row.rows.map((r) => r.logType)),
    hasRowsShape: row.auditEvents.some((e) => isObj(e.details) && 'rows' in e.details),
    hasRowsOmitted: row.auditEvents.some((e) => isObj(e.details) && 'rowsOmitted' in e.details),
  };
}

const PARITY_TABLE: ParityRow[] = [
  {
    // The frozen historical discriminator: a pre-0b-1 mass-update session wrote
    // ADJUSTMENT rows under one batchId and one INVENTORY_BULK_UPDATE summary.
    name: 'audit-rows-shape, no SALE row -> NOT attributable',
    rows: [{ logType: 'ADJUSTMENT' }, { logType: 'ADJUSTMENT' }],
    auditEvents: [
      { actionType: 'INVENTORY_BULK_UPDATE', details: { rows: [{ productId: 1, delta: -3 }] } },
    ],
    attributable: false,
  },
  {
    // >500 rows: `details.rows` is replaced by rowCount + rowsOmitted. The
    // DEGRADED identification, and still not an attributable deduction.
    name: 'rows-omitted (no `rows` key), no SALE row -> NOT attributable',
    rows: [{ logType: 'ADJUSTMENT' }],
    auditEvents: [
      { actionType: 'INVENTORY_BULK_UPDATE', details: { rowCount: 900, rowsOmitted: true } },
    ],
    attributable: false,
  },
  {
    // deduct-simple writes the SAME actionType; the SALE row is the disambiguator.
    name: 'bulk + a SALE row (a live deduction) -> attributable',
    rows: [{ logType: 'SALE' }, { logType: 'ADJUSTMENT' }],
    auditEvents: [
      { actionType: 'INVENTORY_BULK_UPDATE', details: { rows: [{ productId: 1, delta: -1 }] } },
    ],
    attributable: true,
  },
  {
    name: 'no bulk event at all (a single negative adjust) -> attributable',
    rows: [{ logType: 'ADJUSTMENT' }],
    auditEvents: [{ actionType: 'INVENTORY_ADJUSTMENT', details: { intent: 'order' } }],
    attributable: true,
  },
  {
    // The live-deduct audit shape: `details.updates`, never `details.rows`.
    name: 'bulk + details.updates (the live-deduct shape) -> attributable',
    rows: [{ logType: 'SALE' }],
    auditEvents: [
      {
        actionType: 'INVENTORY_BULK_UPDATE',
        details: { updates: [{ productId: 1, delta: -2 }], locationId: 1 },
      },
    ],
    attributable: true,
  },
  {
    // The sixth row: rowsOmitted AND a SALE row. `hasSale` kills both audit
    // branches, so a big deduction is never mistaken for a mass update.
    name: 'rows-omitted + a SALE row -> attributable (hasSale disambiguates)',
    rows: [{ logType: 'SALE' }],
    auditEvents: [
      { actionType: 'INVENTORY_BULK_UPDATE', details: { rowCount: 900, rowsOmitted: true } },
    ],
    attributable: true,
  },
];

describe('R0 — the TS port is byte-for-byte the diagnostics rule', () => {
  it.each(PARITY_TABLE.map((row) => [row.name, row] as const))(
    'parity: %s',
    (_name, row) => {
      const ts = classifyMassUpdateBatch(jsInput(row));
      const js = classifyMassUpdateBatchJs(jsInput(row));
      expect(ts).toEqual(js);
    }
  );

  it.each(PARITY_TABLE.map((row) => [row.name, row] as const))(
    'verdict: %s',
    (_name, row) => {
      expect(isAttributableBatch(row.rows, row.auditEvents)).toBe(row.attributable);
      // ...and the verdict IS the frozen adapter mapping (OCk-10), not a
      // second opinion: !(isMassUpdate || isMassUpdateRowsOmitted).
      const js = classifyMassUpdateBatchJs(jsInput(row));
      expect(isAttributableBatch(row.rows, row.auditEvents)).toBe(
        !(js.isMassUpdate || js.isMassUpdateRowsOmitted)
      );
    }
  );

  it('the `count-logtype` branch is unreachable through this population, and still agrees', () => {
    // A COUNT row cannot reach isAttributableBatch — it fails `rowWhere` before
    // the batch is ever assembled. The branch is kept in the port because it is
    // the diagnostics rule verbatim; both implementations still answer the same.
    const rows = [{ logType: 'COUNT' }];
    const auditEvents: PopulationAuditEvent[] = [];
    const input = { auditActionTypes: new Set<string>(), logTypes: new Set(['COUNT']) };
    expect(classifyMassUpdateBatch(input)).toEqual(classifyMassUpdateBatchJs(input));
    expect(classifyMassUpdateBatch(input).isMassUpdate).toBe(true);
    expect(isAttributableBatch(rows, auditEvents)).toBe(false);
  });

  it('tolerates a NULL / non-object audit `details` (nothing in the ledger promises one)', () => {
    const rows = [{ logType: 'ADJUSTMENT' }];
    expect(
      isAttributableBatch(rows, [{ actionType: 'INVENTORY_BULK_UPDATE', details: null }])
    ).toBe(true);
    expect(
      isAttributableBatch(rows, [{ actionType: 'INVENTORY_BULK_UPDATE', details: 'not an object' }])
    ).toBe(true);
  });

  it('an empty audit set is attributable (a mass update with no summary is invisible to R0)', () => {
    // Stated in the coverage sentence, not fixed here: recordIngestion is
    // best-effort, so a pre-0b-1 session whose summary never landed derives
    // none/unknown with a large row count instead of being excluded.
    expect(isAttributableBatch([{ logType: 'ADJUSTMENT' }], [])).toBe(true);
  });
});
