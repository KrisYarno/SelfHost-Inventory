// @jest-environment node
/**
 * Reconciliation lane R-A — THE ATTEMPTS WRITE BOUNDARY + the APPEND-ONLY gate
 * (spec REV-7 D1/D2 §2.1, pack C1b.5, binding).
 *
 * `order_attribution_attempts` records what the ROUTES saw at the moment stock
 * moved. Two properties make that record worth reading, and neither is provable
 * from the schema:
 *
 *   1. ROUTE-ONLY WRITERS. The row is written beside the audit event, inside the
 *      business transaction, by the seam that actually made the decision. A
 *      `lib/*` helper that wrote one would be recording an attempt on behalf of
 *      a caller it cannot see — and the read path (`lib/reconciliation/*`, which
 *      the assistant's tool surface reaches) must never so much as IMPORT the
 *      writer, because the zero-business-writes invariant is enforced by a
 *      textual scan for Prisma write tokens.
 *   2. APPEND-ONLY. An attempt that was later edited is not a record of an
 *      attempt. Nothing under `app/ lib/ scripts/` may call update / updateMany
 *      / upsert / delete / deleteMany on the delegate, ever.
 *
 * Like exceptions-write-boundary.test.ts, this is a SOURCE SCAN: it never loads
 * a module and never runs a handler, so it cannot be fooled by a mock or flaked
 * by an import chain.
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMITS (registered, not engineered away — the same classes the
 * exceptions boundary names):
 *
 *   E1  DYNAMIC DELEGATE ACCESS. The verb scan matches the literal
 *       `orderAttributionAttempt.<verb>`. A destructured delegate, a computed
 *       property, or a delegate passed as a parameter writes without ever
 *       spelling the token.
 *   E2  RAW SQL. `$executeRaw` UPDATE/DELETE against `order_attribution_attempts`
 *       is not detected by this scan — E2 class; the append-only guarantee is
 *       code review + this token gate.
 *   E3  ALTERNATE SPECIFIERS. The importer scan keys on a path ENDING in
 *       `lib/attribution/attempts`, which covers the `@/` alias and relative
 *       forms. A re-export barrel, or an `await import()` with a computed path,
 *       imports the writer under a name this scan does not recognise.
 *   E4  COMMENTS AND STRINGS. The scan cannot tell code from prose: a mention of
 *       `orderAttributionAttempt.deleteMany` inside a comment fails the gate,
 *       and the only way to suppress it is to reword.
 *
 * `concurrency-gate/` and `__tests__/` sit OUTSIDE the scanned roots on purpose:
 * a fixture reset legitimately deletes rows, and a test file legitimately spells
 * both the import specifier and the forbidden verbs.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

/** The writer module itself — excluded from its own importer scan. */
const WRITER_MODULE = 'lib/attribution/attempts.ts';

/** Source trees the gates sweep. */
const IMPORTER_DIRS = ['app', 'lib', 'scripts', 'mcp/src'];
const APPEND_ONLY_DIRS = ['app', 'lib', 'scripts'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js']);

/**
 * Every file allowed to import the attempt writer.
 *
 * FIVE at M2b — the four live route seams of the D2 table, plus the manual
 * attribution POST (the fifth, landed in the same commit as that route; D2's
 * last row). Entries are ROUTE files by contract: the boundary is stated at the
 * HTTP verb, so a shared lib or a server component cannot be added without
 * consciously re-opening this rule.
 */
interface AttemptsImporter {
  path: string;
  reason: string;
}

const ALLOWED_ATTEMPTS_IMPORTERS: AttemptsImporter[] = [
  {
    path: 'app/api/inventory/deduct-simple/route.ts',
    reason:
      'D2 deduct-simple family: the workbench manual leg is the surface where a packer states ' +
      'an order intent, picks an order or types a reference, so it owns the richest row of the ' +
      'table (selected / reference-resolved / four decline classes / three none classes). The ' +
      "attempt is written inside the deduction's own transaction, after the audit event",
  },
  {
    path: 'app/api/inventory/adjust/route.ts',
    reason:
      'D2 adjust family: a NEGATIVE adjustment that is not a transfer auto-add moves stock out ' +
      'and therefore has an attribution question to answer. Positive adjusts and auto-adds write ' +
      'no attempt at all — nothing left the building, so there is nothing to attribute',
  },
  {
    path: 'app/api/inventory/batch-adjust/route.ts',
    reason:
      'D2 batch-adjust family: the journal offers no order context of any kind, so its one row ' +
      'per batch is the constant none/no-order-context — recorded rather than omitted so the ' +
      'report can tell "we asked and there was nothing" from "this batch never reached the lane"',
  },
  {
    path: 'app/api/orders/[orderId]/fulfill/route.ts',
    reason:
      'D2 fulfillment family: fulfilling an external order IS the attribution — the order came ' +
      'from the path, was membership-checked, and stamped every SALE row. The attempt records ' +
      'attributed/fulfillment with the first non-sentinel ledger row (NULL for a bundle-only fulfillment)',
  },
  {
    path: 'app/api/reconciliation/attribution/[batchId]/route.ts',
    reason:
      'M2b: the manual attribution writes its attempt row (evidence manual) in the same tx as ' +
      'the guarded ledger UPDATE and the INVENTORY_ATTRIBUTE audit event',
  },
];

/**
 * An import of the writer by any specifier that ENDS in its module path: the
 * `@/` alias, a relative climb, or a dynamic `import()` / `require()`.
 */
const ATTEMPTS_IMPORT =
  /(?:from|import|require)\s*\(?\s*['"][^'"]*lib\/attribution\/attempts['"]/;

/** Any mutation of the append-only table through the Prisma delegate. */
const APPEND_ONLY_VIOLATION =
  /\borderAttributionAttempt\s*\.\s*(?:update|updateMany|upsert|delete|deleteMany)\s*\(/;

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function walk(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
      found.push(...walk(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found.sort();
}

interface SourceFile {
  path: string;
  text: string;
}

function collect(dirs: readonly string[]): SourceFile[] {
  return dirs.flatMap((dir) =>
    walk(path.join(REPO_ROOT, dir)).map((abs) => ({
      path: toRepoPath(abs),
      text: fs.readFileSync(abs, 'utf8'),
    })),
  );
}

let importerSources: SourceFile[];
let appendOnlySources: SourceFile[];

beforeAll(() => {
  importerSources = collect(IMPORTER_DIRS);
  appendOnlySources = collect(APPEND_ONLY_DIRS);
});

describe('attempts write boundary — NAMED importers only', () => {
  it('sweeps a sane source surface (guards against discovery rot)', () => {
    expect(importerSources.length).toBeGreaterThanOrEqual(300);
    expect(importerSources.some((s) => s.path === WRITER_MODULE)).toBe(true);
  });

  it('the files importing the writer are EXACTLY the allow list', () => {
    const importers = importerSources
      .filter((s) => s.path !== WRITER_MODULE && ATTEMPTS_IMPORT.test(s.text))
      .map((s) => s.path);

    // Bidirectional: an unlisted importer fails, and so does an allow-list entry
    // whose route stopped importing the writer (a silently unwired seam).
    expect(importers.sort()).toEqual(ALLOWED_ATTEMPTS_IMPORTERS.map((c) => c.path).sort());
  });

  it('the allow list is EXACTLY five entries at M2b (the four live seams + the manual POST)', () => {
    // A COUNT, not just a set comparison: the number is quoted in the spec, the
    // pack and this file's header, and a silent drift in either direction is
    // exactly what a boundary gate exists to catch.
    expect(ALLOWED_ATTEMPTS_IMPORTERS).toHaveLength(5);
  });

  it('allow-list hygiene: unique, existing, reasoned — and each really imports the writer', () => {
    const seen = new Set<string>();
    for (const importer of ALLOWED_ATTEMPTS_IMPORTERS) {
      expect(seen.has(importer.path)).toBe(false);
      seen.add(importer.path);
      expect(importer.path.endsWith('/route.ts')).toBe(true);
      expect(fs.existsSync(path.join(REPO_ROOT, importer.path))).toBe(true);
      expect(importer.reason.trim().length).toBeGreaterThan(0);
      const text = fs.readFileSync(path.join(REPO_ROOT, importer.path), 'utf8');
      expect(ATTEMPTS_IMPORT.test(text)).toBe(true);
    }
  });

  it('NO module under lib/ imports the writer (the read path must stay clean)', () => {
    const offenders = importerSources
      .filter((s) => s.path.startsWith('lib/') && s.path !== WRITER_MODULE)
      .filter((s) => ATTEMPTS_IMPORT.test(s.text))
      .map((s) => `  ${s.path}`);

    expect(
      offenders.length === 0
        ? ''
        : `lib/ modules importing the attempt writer. The write boundary is stated at the ROUTE\n` +
            `(pack C1b.5), and lib/reconciliation/* is additionally reachable from the assistant's\n` +
            `read-only tool surface — it takes its TYPES from lib/attribution/contracts.ts:\n` +
            offenders.join('\n'),
    ).toBe('');
  });

  it('the importer regex is not vacuous (positive control)', () => {
    expect(ATTEMPTS_IMPORT.test("import { recordAttributionAttempt } from '@/lib/attribution/attempts';")).toBe(true);
    expect(ATTEMPTS_IMPORT.test("from '../../../lib/attribution/attempts'")).toBe(true);
    expect(ATTEMPTS_IMPORT.test("import('@/lib/attribution/attempts')")).toBe(true);
    // The types module is NOT the writer — importing it is always legal.
    expect(ATTEMPTS_IMPORT.test("from '@/lib/attribution/contracts'")).toBe(false);
  });
});

/**
 * QA-6 — ONE AUDIT EVENT PER LEDGER BATCH.
 *
 * The attribution report's LIST read joins each batch's audit rows by scalar
 * subquery: the earliest one for the derivation's facts, and the batch's
 * fulfillment event for R2/R2b. It never materialises the whole set, so what it
 * can see depends on what the WRITERS filed under the ledger batchId — and the
 * rule that makes that read complete is that each of the four D2 seams mints ONE
 * batch id and records ONE change event under it.
 *
 * A second `recordChange` under the same batch id would file an audit row the
 * list read reaches only if it happens to be the earliest or a fulfillment — so
 * this is a SOURCE SCAN, in the file that already owns the writers' boundary,
 * and it fails loudly rather than letting the report quietly go partial.
 *
 * The FIFTH importer (the manual-attribution POST) is deliberately not here: it
 * mints a SEPARATE audit batch id for its INVENTORY_ATTRIBUTE event precisely so
 * that event does NOT land under the ledger batch it describes (its ENTITY is
 * the ledger batchId instead) — the same rule, stated the other way round.
 */
const BATCH_MINTING_WRITERS: readonly string[] = [
  'app/api/inventory/deduct-simple/route.ts',
  'app/api/inventory/adjust/route.ts',
  'app/api/inventory/batch-adjust/route.ts',
  'app/api/orders/[orderId]/fulfill/route.ts',
];

function occurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe('one ledger batch id, one audit event (QA-6)', () => {
  it.each(BATCH_MINTING_WRITERS)('%s mints ONE batch id and records ONE change', (writer) => {
    const full = path.join(REPO_ROOT, writer);
    expect(fs.existsSync(full)).toBe(true);
    const text = fs.readFileSync(full, 'utf8');

    expect(occurrences(text, /\bnewBatchId\s*\(\s*\)/g)).toBe(1);
    expect(occurrences(text, /\brecordChange\s*\(/g)).toBe(1);
  });

  it('the counter is not vacuous (positive control: a route that really records three)', () => {
    // `app/api/admin/users/[userId]/route.ts` records three changes under one
    // batch id. It is not a ledger writer, so it is not on the list above — it is
    // here to prove the counter would SEE a second `recordChange` if one appeared.
    const text = fs.readFileSync(
      path.join(REPO_ROOT, 'app/api/admin/users/[userId]/route.ts'),
      'utf8',
    );
    expect(occurrences(text, /\brecordChange\s*\(/g)).toBe(3);
    expect(occurrences(text, /\bnewBatchId\s*\(\s*\)/g)).toBe(1);
  });

  it('the manual attribution files its event under its OWN batch id, not the ledger batch', () => {
    const text = fs.readFileSync(
      path.join(REPO_ROOT, 'app/api/reconciliation/attribution/[batchId]/route.ts'),
      'utf8',
    );
    expect(occurrences(text, /\brecordChange\s*\(/g)).toBe(1);
    // The audit event's batchId is the request's own, minted beside it.
    expect(text).toMatch(/batchId:\s*auditBatchId/);
  });
});

describe('attempts append-only — no mutating verb anywhere in app/ lib/ scripts/', () => {
  it('the delegate is never updated, upserted or deleted', () => {
    const offenders = appendOnlySources
      .filter((s) => APPEND_ONLY_VIOLATION.test(s.text))
      .map((s) => `  ${s.path}`);

    expect(
      offenders.length === 0
        ? ''
        : `Files mutating order_attribution_attempts. The table is APPEND-ONLY (spec REV-7 §2.1):\n` +
            `an attempt that was later edited is not a record of an attempt. Write a NEW row:\n` +
            offenders.join('\n'),
    ).toBe('');
  });

  it('the verb regex is not vacuous (positive control)', () => {
    for (const verb of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
      expect(APPEND_ONLY_VIOLATION.test(`await tx.orderAttributionAttempt.${verb}({})`)).toBe(true);
    }
    // The READ verbs the report and the derivation need stay legal.
    for (const verb of ['create', 'findMany', 'findFirst', 'count', 'groupBy']) {
      expect(APPEND_ONLY_VIOLATION.test(`await tx.orderAttributionAttempt.${verb}({})`)).toBe(false);
    }
  });

  it('sweeps a sane append-only surface', () => {
    expect(appendOnlySources.length).toBeGreaterThanOrEqual(300);
  });
});
