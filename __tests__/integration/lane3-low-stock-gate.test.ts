/**
 * @jest-environment node
 *
 * Trunk enforcement gate for the low-stock threshold model (Lane 3 spec §3 D10
 * / §10 R-L13, plan P-L4). Scans app/ components/ lib/ BY FIELD/PREDICATE USAGE
 * (not a bare literal grep, codex #5): any file that computes a low-stock
 * predicate — coalescing `lowStockThreshold` to a default, an inline
 * `currentQuantity <= N`, a `low_stock` SQL status, `isLowStock =`,
 * `showLowStockOnly`, `LOW_STOCK_DEFAULT`, or a `const lowStockThreshold = N` —
 * MUST import the shared helper (`@/lib/stock-threshold`) OR appear on the
 * EXEMPT list.
 *
 * EXEMPT is initialized to the CURRENT offender set so this passes today; Task 7
 * converts each consumer to the helper and removes it (the list must reach EMPTY
 * before the wave closes). Each EXEMPT entry is asserted to still exist, still
 * match the predicate signal, and NOT yet import the helper — so a converted
 * file cannot linger on the list.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ['app', 'components', 'lib'];
const HELPER_FILE = 'lib/stock-threshold.ts';

const SIGNAL_PATTERNS: readonly RegExp[] = [
  /low_stock/, // raw SQL status / notificationType
  /LOW_STOCK_DEFAULT/, // module-level default const
  /isLowStock\s*=/, // local low-stock boolean recompute
  /showLowStockOnly/, // list filter using a literal compare
  /lowStockThreshold\s*(\?\?|\|\|)\s*[^;,)\s]/, // coalesce field -> a default (inherit/disable materialization)
  /const\s+lowStockThreshold\s*=\s*\d/, // hardcoded default const
  /currentQuantity[^\n]*<=?\s*[1-9]/, // inline low-stock literal against stock on hand
];

const HELPER_IMPORT = /from\s*['"]@\/lib\/stock-threshold['"]/;

// Plan P-L4: the 20-site offender seed was emptied by Task 7's sweep (2026-07-11).
// Every low-stock predicate site now imports @/lib/stock-threshold. New offenders
// fail the gate; additions to this list require orchestrator sign-off.
const EXEMPT: readonly string[] = [];

function walk(absDir: string, out: string[]): void {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path.relative(REPO_ROOT, abs));
    }
  }
}

function scanFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir), out);
  return out;
}

const matchesSignal = (content: string) => SIGNAL_PATTERNS.some((re) => re.test(content));
const importsHelper = (content: string) => HELPER_IMPORT.test(content);

describe('low-stock threshold enforcement gate', () => {
  const files = scanFiles();

  it('scans a plausible number of source files (self-check)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(HELPER_FILE);
  });

  it('every low-stock predicate site imports the helper OR is exempt', () => {
    const exemptSet = new Set(EXEMPT);
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel === HELPER_FILE) continue;
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      if (!matchesSignal(content)) continue;
      if (importsHelper(content)) continue;
      if (exemptSet.has(rel)) continue;
      offenders.push(rel);
    }
    // A failure names the file: route it through effectiveLowStockThreshold /
    // isLowStock, or (only if it genuinely computes low stock and Task 7 will
    // convert it) add it to EXEMPT.
    expect(offenders).toEqual([]);
  });

  it('every EXEMPT entry exists, still offends, and is NOT yet converted (forces shrink)', () => {
    const problems: string[] = [];
    for (const rel of EXEMPT) {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) {
        problems.push(`${rel}: no longer exists (remove from EXEMPT)`);
        continue;
      }
      const content = fs.readFileSync(abs, 'utf8');
      if (!matchesSignal(content)) {
        problems.push(`${rel}: no longer matches a low-stock signal (remove from EXEMPT)`);
      }
      if (importsHelper(content)) {
        problems.push(`${rel}: now imports the helper — remove it from EXEMPT`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('EXEMPT has no duplicates', () => {
    expect(new Set(EXEMPT).size).toBe(EXEMPT.length);
  });
});
