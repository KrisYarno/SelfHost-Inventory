/**
 * NOT ON THE READ PATH (reconciliation lane, pack C2b.5 / R-4; spec REV-7 D4).
 *
 * M2b lands the lane's first WRITER — `lib/reconciliation/attribute-batch.ts`,
 * which locks ledger rows and re-stamps them. Four modules in the same directory
 * are reachable from `lib/assistant/tools.ts`, where the zero-business-writes
 * invariant is enforced by a TEXTUAL scan: a Prisma write-method token anywhere
 * in their source — comments included — fails the toolsuite gate.
 *
 * So this file pins the boundary from the other side, at the moment the writer
 * arrives rather than at M5a when the tool wires the producer in:
 *
 *   1. none of the four read modules imports the manual-attribution core;
 *   2. none of them imports the attempt writer (they take their vocabulary from
 *      `lib/attribution/contracts.ts`, which is types-only);
 *   3. none of them carries a write token at all, in code OR in prose — the R-4
 *      rule that D4 is described BY NAME ("the manual-attribution core"), never
 *      by the method it calls.
 *
 * A SOURCE SCAN, deliberately: it loads nothing and runs nothing, so no mock and
 * no import graph can talk it out of its answer. The positive controls below
 * prove each pattern still bites.
 *
 * (Sibling files share this name under `__tests__/integration/` and
 * `__tests__/unit/lib/` — both are older, unrelated product-approval matrices.
 * The pack names this path; the directory is what tells them apart.)
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The four modules the assistant's tool surface can reach (pack R-4). */
const READ_MODULES = [
  'lib/reconciliation/population.ts',
  'lib/reconciliation/derive.ts',
  'lib/reconciliation/pii.ts',
  'lib/reconciliation/attribution.ts',
];

/** The write module they must never reach, and the writer beside it. */
const FORBIDDEN_IMPORTS = [
  { token: 'attribute-batch', what: 'the manual-attribution core (pack C2b.2)' },
  { token: 'lib/attribution/attempts', what: 'the attempt writer (pack C1b.1)' },
];

/**
 * The R-4 token set, spelled exactly as the toolsuite gate spells it
 * (`toolsuite-gates.test.ts` WRITE_TOKEN_SRC). Kept as a literal rather than
 * imported: two independent copies of a boundary rule is the point — a
 * narrowing of one can never quietly narrow the other.
 */
const WRITE_TOKEN_SRC =
  '\\.\\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\\s*\\(|' +
  '\\$(executeRaw|executeRawUnsafe|queryRawUnsafe)\\b';

function source(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('the reconciliation read path never reaches the write path', () => {
  it.each(READ_MODULES)('%s imports neither the core nor the attempt writer', (rel) => {
    const src = source(rel);
    const offenders = FORBIDDEN_IMPORTS.filter((f) => src.includes(f.token)).map(
      (f) => `${rel} names "${f.token}" — ${f.what}`,
    );
    expect(offenders).toEqual([]);
  });

  it.each(READ_MODULES)('%s carries no Prisma write token, comments included', (rel) => {
    const src = source(rel);
    const re = new RegExp(WRITE_TOKEN_SRC, 'g');
    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      found.push(m[1] ?? `$${m[2]}`);
    }
    expect(found).toEqual([]);
  });

  it('the write module DOES carry one (the scan is not vacuous)', () => {
    const src = source('lib/reconciliation/attribute-batch.ts');
    expect(new RegExp(WRITE_TOKEN_SRC).test(src)).toBe(true);
  });

  it('the patterns bite (positive controls)', () => {
    const re = () => new RegExp(WRITE_TOKEN_SRC);
    expect(re().test('await tx.inventory_logs.updateMany({})')).toBe(true);
    expect(re().test('// the core calls .updateMany( on the locked rows')).toBe(true);
    expect(re().test('await prisma.$executeRaw`UPDATE inventory_logs SET x = 1`')).toBe(true);
    expect(re().test('const rows = await prisma.$queryRaw(sql)')).toBe(false);

    expect("import { attributeBatch } from '@/lib/reconciliation/attribute-batch';").toContain(
      'attribute-batch',
    );
    expect("import { recordAttributionAttempt } from '@/lib/attribution/attempts';").toContain(
      'lib/attribution/attempts',
    );
    // The TYPES module is not the writer — the producers import it by design.
    expect("from '@/lib/attribution/contracts'").not.toContain('lib/attribution/attempts');
  });

  it('every scanned module EXISTS (a stale entry scans nothing)', () => {
    for (const rel of [...READ_MODULES, 'lib/reconciliation/attribute-batch.ts']) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });
});
