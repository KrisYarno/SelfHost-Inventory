/**
 * @jest-environment node
 *
 * THE LEGACY DISCRIMINATOR GATE (spec REV-10 clause 4, codex CR-4).
 *
 * `staging_items.receivedAt IS NOT NULL` is what makes a row a LEGACY
 * (pre-staging) box: it is the durable, column-level discriminator the archive
 * read, the ops-health straggler count and the cutover runbook all key on.
 *
 * The migration KEEPS the column's `DEFAULT CURRENT_TIMESTAMP` — deliberately,
 * so a code rollback to the pre-overhaul box-create (which omits the column and
 * leans on that default) stays schema-compatible. The cost of that decision is
 * that OMISSION IS NOT ABSENCE any more: a new-flow `stagingItem.create` that
 * simply leaves `receivedAt` out gets stamped by MySQL, and the row starts
 * reading as legacy history.
 *
 * So the protection lives on the CODE side, and this gate is what makes it
 * permanent: every `stagingItem.create` / `createMany` in the production tree
 * (and the concurrency gate's seed) must say `receivedAt: null` out loud.
 *
 * A SOURCE SCAN, like the exceptions write boundary and the change-tracking
 * coverage gate: it never loads a module, so it cannot be fooled by a mock, and
 * it fails on the NEXT create site somebody adds rather than on the next
 * incident. Its known limit is the same one those gates carry — a create
 * assembled through a helper, a spread, or a computed delegate name is invisible
 * to it (registered, not engineered away; the query-shape pins in each route
 * suite are the second, independent check).
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

/** Trees that may legitimately create a staging line. */
const SCANNED_DIRS = ['app', 'lib', 'components', 'hooks', 'concurrency-gate', 'launch-gate'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** A create against the staging delegate, on prisma or on a tx client. */
const STAGING_CREATE = /\bstagingItem\s*\.\s*(create|createMany)\b/;

function walk(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
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

let sources: SourceFile[];

beforeAll(() => {
  sources = SCANNED_DIRS.flatMap((dir) =>
    walk(path.join(REPO_ROOT, dir)).map((abs) => ({
      path: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
      text: fs.readFileSync(abs, 'utf8'),
    })),
  );
});

describe('the legacy discriminator survives the kept receivedAt default', () => {
  it('sweeps a sane source surface (guards against discovery rot)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(300);
  });

  it('is not vacuous — the create sites it is meant to police are there', () => {
    const creators = sources.filter((s) => STAGING_CREATE.test(s.text)).map((s) => s.path);
    expect(creators).toContain('app/api/inbound-shipments/route.ts');
    expect(creators).toContain('app/api/inbound-shipments/[id]/lines/route.ts');
  });

  it('every staging-line create writes receivedAt: null EXPLICITLY', () => {
    const offenders = sources
      .filter((s) => STAGING_CREATE.test(s.text))
      .filter((s) => !/receivedAt:\s*null/.test(s.text))
      .map((s) => `  ${s.path}`);

    expect(
      offenders.length === 0
        ? ''
        : `Staging-line creates that do not say receivedAt: null. The column KEEPS its\n` +
            `DEFAULT CURRENT_TIMESTAMP (spec REV-10 clause 4), so an omitted field is STAMPED —\n` +
            `and receivedAt IS NOT NULL is the legacy discriminator. Say it out loud:\n` +
            offenders.join('\n'),
    ).toBe('');
  });

  it('the concurrency gate seeds its lines the same way', () => {
    const seed = sources.find((s) => s.path === 'concurrency-gate/seed.ts');
    expect(seed).toBeDefined();
    expect(/receivedAt:\s*null/.test(seed!.text)).toBe(true);
  });
});
