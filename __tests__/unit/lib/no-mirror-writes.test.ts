/**
 * @jest-environment node
 *
 * THE `products.quantity` RETIREMENT, PINNED AT THE SOURCE (pack CB2.5a.3, seam
 * S-B22).
 *
 * `products.quantity` was a hand-maintained MIRROR of the location-1
 * `product_locations` row: nothing read it semantically, five writers kept it in
 * step inside their own transactions, and the extra X lock it took on the
 * product row was the second half of this lane's engine-traced deadlock (the FK
 * S lock any INSERT referencing the product takes -> the mirror's X upgrade).
 * P2-B2.5 stopped every writer. The COLUMN stays (its drop rides a later
 * rehearsed migration wave, SETTLED 20), so nothing in the schema prevents a
 * future edit from quietly starting to write it again — which is what this gate
 * is for.
 *
 * IT IS AN ALLOWLIST, not a regex over the write's argument (round 2,
 * B25-OC2-1). A pattern that reads the call's data object is defeated by
 * `data: updateData` indirection — the repo already writes exactly that at
 * `app/api/products/[id]/route.ts` and `scripts/backfill-product-variants.js` —
 * and a statement window false-positives across a `Promise.all` comma. So:
 *
 *   RULE (i)   No file OUTSIDE the allowlist contains a `products` writer at
 *              all, in any spelling this repo uses.
 *   RULE (ii)  Every ALLOWLISTED file's writer CALL WINDOWS — the balanced
 *              argument, walked by brace depth rather than matched by a regex —
 *              never name `quantity`.
 *
 * THE CLAIM, stated exactly: after B2.5 no statement under the scanned roots
 * UPDATES or increments `products.quantity`; the creates that remain write only
 * its schema default (`quantity Int @default(0)`).
 *
 * A SOURCE SCAN, like the exceptions write boundary and the legacy discriminator
 * gate: it never loads a module, so no mock can fool it, and it fails on the
 * NEXT writer somebody adds rather than on the next incident. Raw text INCLUDING
 * comments, case-SENSITIVE, `.ts`/`.js` only (not `.tsx` — no client component
 * writes Prisma). A prose occurrence under the roots is therefore a rewrite, by
 * design: the pack would rather re-word a comment than carry a scanner that
 * decides what code is.
 *
 * TWO RESIDUALS, STATED, NOT ENGINEERED AWAY:
 *   - Rule (ii) reads the LITERAL argument window, so a `quantity` smuggled
 *     through a local `const data = …` inside an ALLOWLISTED file is not caught
 *     (B25-OC3-4). The allowlisted files carry that by decision; every other
 *     file is caught by rule (i) regardless of spelling.
 *   - The scan roots are stated, not universal. `launch-gate/` sits outside them
 *     (B25-OC4-5); its own seed dropped the mirror keys in the same wave, but
 *     this pin does not police that directory.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

/** Every tree a `products` writer could legitimately live in. */
const SCANNED_DIRS = ['lib', 'app', 'mcp/src', 'scripts', 'concurrency-gate'];

/** `scripts/diagnostics/` READS the column on purpose (the d4 artifact). */
const EXCLUDED_DIRS = ['scripts/diagnostics'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.js']);

/**
 * Every spelling of a `products` write this repo uses — Prisma delegate calls on
 * `prisma` or on a tx client, and the two raw-SQL forms. Case-sensitive: the
 * repo writes SQL keywords upper-case and delegates lower-case, and a matcher
 * that guesses at case invites a false negative nobody reads.
 */
const PRODUCT_WRITE_PATTERNS = [
  '.product.update(',
  '.product.updateMany(',
  '.product.create(',
  '.product.createMany(',
  '.product.upsert(',
  'UPDATE products',
  'products SET',
] as const;

/** The delegate calls rule (ii) opens and walks. */
const WRITE_CALL = /\.product\.(update|updateMany|create|createMany|upsert)\s*\(/g;

/**
 * THE ALLOWLIST, BY REAL PATH (round 3, B25-G3-1 / B25-OC3-1 — an earlier draft
 * named two files that do not exist). Every entry is a NON-STOCK product writer:
 * it changes the product ROW (approval, deletion, cost, price, thresholds,
 * identity), never the stock the ledger owns.
 *
 * `lib/supply-orders/booking.ts` is listed with NO match by design (B25-OC4-6):
 * its step-6b `SELECT … FOR UPDATE` is a locking READ, which matches none of the
 * seven patterns. It is here for the record, because it is one of the two paths
 * that still take an X lock on `products` (pack CB2.5a.2) — and the pin below
 * asserts it stays a no-match, so a real writer appearing there is a decision
 * somebody has to make out loud.
 */
const ALLOWLIST = [
  'lib/products/decline.ts',
  'lib/products/cost.ts',
  'lib/supply-orders/booking.ts',
  'lib/supply-orders/product-resolve.ts',
  'lib/external-orders/price-sync.ts',
  'app/api/admin/products/[id]/approve/route.ts',
  'app/api/admin/products/[id]/restore/route.ts',
  'app/api/admin/products/thresholds/route.ts',
  'app/api/products/route.ts',
  'app/api/products/[id]/route.ts',
  'app/api/products/[id]/price-source/route.ts',
  'scripts/backfill-product-variants.js',
  'concurrency-gate/seed.ts',
] as const;

/** The one allowlist entry that is expected to match NOTHING. */
const NO_MATCH_BY_DESIGN = 'lib/supply-orders/booking.ts';

const ALLOWED = new Set<string>(ALLOWLIST);

interface SourceFile {
  path: string;
  text: string;
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

function relative(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/**
 * THE ARGUMENT WALK. From the call's opening `(`, advance one character at a
 * time tracking bracket DEPTH — `(`, `[` and `{` open, `)`, `]` and `}` close —
 * and stop where the depth returns to zero. Quoted strings, template literals
 * and comments are skipped so a bracket inside one cannot unbalance the window;
 * the window itself is returned RAW, comments included, because what rule (ii)
 * asks is whether the call NAMES the column, not whether the compiler would.
 *
 * A regex could not do this: the write's argument is a nested object literal
 * whose end no fixed pattern locates, and a fixed-length window either stops
 * short of the key or runs past the statement.
 */
function callWindow(text: string, openParenIndex: number): string {
  let depth = 0;
  let i = openParenIndex;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openParenIndex, i + 1);
    }
    i += 1;
  }
  return text.slice(openParenIndex);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

let sources: SourceFile[];

beforeAll(() => {
  const excluded = EXCLUDED_DIRS.map((dir) => `${dir}/`);
  sources = SCANNED_DIRS.flatMap((dir) =>
    walk(path.join(REPO_ROOT, dir))
      .map((abs) => relative(abs))
      .filter((rel) => !excluded.some((prefix) => rel.startsWith(prefix)))
      .map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8') }))
      .map(({ rel, text }) => ({ path: rel, text })),
  );
});

describe('the loc-1 `products.quantity` mirror is retired (pack CB2.5a.3)', () => {
  it('sweeps a sane source surface (guards against discovery rot)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(300);
    // The roots are the ones the pack names, and the diagnostics tree — which
    // READS the column — is out.
    expect(sources.some((s) => s.path.startsWith('lib/'))).toBe(true);
    expect(sources.some((s) => s.path.startsWith('app/api/'))).toBe(true);
    expect(sources.some((s) => s.path.startsWith('mcp/src/'))).toBe(true);
    expect(sources.some((s) => s.path.startsWith('scripts/'))).toBe(true);
    expect(sources.some((s) => s.path.startsWith('concurrency-gate/'))).toBe(true);
    expect(sources.some((s) => s.path.startsWith('scripts/diagnostics/'))).toBe(false);
  });

  it('is not vacuous — every allowlisted path EXISTS and the writers it names are found', () => {
    // Round 3's defect, pinned: an allowlist entry that names a file which is not
    // there protects nothing and hides the rot.
    const missing = ALLOWLIST.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
    expect(missing).toEqual([]);

    const scanned = new Set(sources.map((s) => s.path));
    expect(ALLOWLIST.filter((rel) => !scanned.has(rel))).toEqual([]);

    const writers = sources
      .filter((s) => PRODUCT_WRITE_PATTERNS.some((pattern) => s.text.includes(pattern)))
      .map((s) => s.path);
    // A representative sample of the non-stock writers the allowlist exists for.
    expect(writers).toContain('lib/products/decline.ts');
    expect(writers).toContain('lib/products/cost.ts');
    expect(writers).toContain('app/api/products/[id]/route.ts');
  });

  it('RULE (i): no file outside the allowlist writes `products` at all', () => {
    const offenders: string[] = [];
    for (const source of sources) {
      if (ALLOWED.has(source.path)) continue;
      for (const pattern of PRODUCT_WRITE_PATTERNS) {
        let at = source.text.indexOf(pattern);
        while (at !== -1) {
          offenders.push(`  ${source.path}:${lineOf(source.text, at)}  ${pattern}`);
          at = source.text.indexOf(pattern, at + pattern.length);
        }
      }
    }

    expect(
      offenders.length === 0
        ? ''
        : 'A `products` writer appeared outside the allowlist. `products.quantity` is a\n' +
            'RETIRED loc-1 mirror (P2-B2.5) awaiting its drop migration, and an X lock on the\n' +
            'product row inside a stock transaction is the deadlock this lane traced out of\n' +
            'the engine. If this is a legitimate NON-STOCK product write (approval, deletion,\n' +
            'cost, price, thresholds, identity) that takes no `product_locations` lock before\n' +
            'it, add the file to ALLOWLIST here AND to pack CB2.5a.2/CB2.5a.3 — never\n' +
            'silently:\n' +
            offenders.join('\n'),
    ).toBe('');
  });

  it('RULE (ii): no allowlisted writer names `quantity` in its argument', () => {
    const offenders: string[] = [];
    for (const source of sources) {
      if (!ALLOWED.has(source.path)) continue;
      WRITE_CALL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WRITE_CALL.exec(source.text)) !== null) {
        const openParen = source.text.indexOf('(', match.index);
        const window = callWindow(source.text, openParen);
        if (/\bquantity\b/.test(window)) {
          offenders.push(`  ${source.path}:${lineOf(source.text, match.index)}  .product.${match[1]}(`);
        }
      }
    }

    expect(
      offenders.length === 0
        ? ''
        : 'An allowlisted product writer NAMES `quantity`. The column is the retired loc-1\n' +
            'mirror (P2-B2.5): a create should let the schema default (0) stand and an update\n' +
            'should not touch it at all. Drop the key:\n' +
            offenders.join('\n'),
    ).toBe('');
  });

  it('the concurrency gate seeds `quantity: 0` only through its FIXTURE RESET', () => {
    // The one allowlisted `quantity` in the tree, and why rule (ii) does not see
    // it: `productRestoreData` hands the createMany/upsert a value by identifier.
    // It restores a dead column to its schema default so a gate run starts from
    // the seeded shape — no product code writes it.
    const seed = sources.find((s) => s.path === 'concurrency-gate/seed.ts');
    expect(seed).toBeDefined();
    expect(/function productRestoreData\([\s\S]*?quantity: 0,/.test(seed!.text)).toBe(true);
  });

  it('booking.ts stays a no-match allowlist entry (its 6b read is a locking SELECT)', () => {
    const booking = sources.find((s) => s.path === NO_MATCH_BY_DESIGN);
    expect(booking).toBeDefined();
    const matched = PRODUCT_WRITE_PATTERNS.filter((pattern) => booking!.text.includes(pattern));
    // If this fails, booking gained a real `products` writer — which changes the
    // survivor analysis in pack CB2.5a.2, not just this list.
    expect(matched).toEqual([]);
  });

  it('the five retired mirror sites stay retired', () => {
    // The pack's five deletions, named individually so a revert reads as itself
    // rather than as an anonymous allowlist violation.
    const byPath = new Map(sources.map((s) => [s.path, s.text]));
    const retired = [
      'lib/inventory.ts',
      'lib/fulfillment.ts',
      'app/api/orders/[orderId]/unfulfill/route.ts',
      'app/api/admin/inventory/mass-update/route.ts',
    ];
    for (const rel of retired) {
      const text = byPath.get(rel);
      expect(text).toBeDefined();
      expect(PRODUCT_WRITE_PATTERNS.filter((pattern) => text!.includes(pattern))).toEqual([]);
    }
  });
});
