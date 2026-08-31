/**
 * ONE HOME FOR THE PRELOCK (Part 2, plan P-2; pack CB0.1).
 *
 * The lock order is only an invariant while there is exactly ONE spelling of
 * it. Four waves each hand-write the materialize INSERT and the lane has four
 * lock disciplines that agree until the day one of them is edited — which is
 * how `batch-adjust/route.ts` came to carry its own inline `product_locations`
 * read in the first place (finding G1p2-1 / OCp2-1).
 *
 * So this file scans the SOURCE, the way the read-path gate does: it loads
 * nothing and runs nothing, so no mock and no import graph can talk it out of
 * its answer. Exactly one file under `lib/` + `app/` may contain the INSERT
 * literal, and that file is `lib/inventory/prelock.ts`.
 *
 * Whitespace-folded on both sides so a reformat of the template — or of this
 * pin — never turns into a false pass or a false failure.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The two trees a writer could plausibly live in. */
const SCANNED_TREES = ['lib', 'app'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** The canonical prelock's statement 1, exactly as `prelock.ts` spells it. */
const INSERT_LITERAL =
  'INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)';

/** The one file allowed to carry it. */
const THE_OWNER = 'lib/inventory/prelock.ts';

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

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

function fold(text: string): string {
  return text.replace(/\s+/g, ' ');
}

const SOURCES = SCANNED_TREES.reduce<Array<{ path: string; folded: string }>>((acc, tree) => {
  walk(path.join(REPO_ROOT, tree)).forEach((abs) => {
    acc.push({ path: toRepoPath(abs), folded: fold(fs.readFileSync(abs, 'utf8')) });
  });
  return acc;
}, []);

describe('the materialize INSERT has exactly one home', () => {
  it('scans a non-trivial number of sources (the walk itself is not vacuous)', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES.map((s) => s.path)).toContain(THE_OWNER);
  });

  it(`only ${THE_OWNER} contains the INSERT literal`, () => {
    const carriers = SOURCES.filter((s) => s.folded.includes(INSERT_LITERAL)).map((s) => s.path);

    expect(carriers).toEqual([THE_OWNER]);
  });

  it('the pin bites — the literal is not a substring the scan can never find', () => {
    const owner = SOURCES.find((s) => s.path === THE_OWNER);
    expect(owner).toBeDefined();
    expect((owner as { folded: string }).folded).toContain(INSERT_LITERAL);
    expect(SOURCES.filter((s) => s.folded.includes('ON DUPLICATE KEY UPDATE version = version'))
      .map((s) => s.path)).toEqual([THE_OWNER]);
  });
});
