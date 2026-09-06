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
 *   RULE (iii) NO file, allowlisted or not, reaches `products.quantity` through
 *              a NESTED RELATION write (B25-FR1/F4): `data: { products: {
 *              update: { quantity: … } } }` off ANY delegate is the same write
 *              wearing a different spelling, and rules (i)/(ii) never see it
 *              because the delegate is not `.product.`. The relation names come
 *              from `prisma/schema.prisma` at test time, so a new relation to
 *              `Product` is policed the day it is added.
 *
 * THE CLAIM, stated exactly: after B2.5 no statement under the scanned roots
 * UPDATES or increments `products.quantity` OUTSIDE the gate's fixture reset
 * (`concurrency-gate/seed.ts` `productRestoreData`, pinned below); the creates
 * that remain write only its schema default (`quantity Int @default(0)`).
 *
 * A SOURCE SCAN, like the exceptions write boundary and the legacy discriminator
 * gate: it never loads a module, so no mock can fool it, and it fails on the
 * NEXT writer somebody adds rather than on the next incident. Raw text INCLUDING
 * comments; `.ts`, `.js` AND `.tsx` (B25-FR1/F4: a server component or a
 * `"use server"` action in a `.tsx` holds Prisma just as well —
 * `app/(app)/admin/product-mappings/[integrationId]/map/page.tsx` imports
 * `@/lib/prisma` today; `components/` joined the roots for the same reason).
 * The DELEGATE spellings stay case-SENSITIVE (the repo
 * writes them lower-case and a case-blind matcher there buys nothing); the RAW
 * SQL spellings are case-INSENSITIVE regexes, because `update products set` is
 * the same statement as `UPDATE products SET` and only one of them was caught.
 * A prose occurrence under the roots is therefore a rewrite, by design: the pack
 * would rather re-word a comment than carry a scanner that decides what code is.
 *
 * FIVE RESIDUALS, STATED, NOT ENGINEERED AWAY:
 *   - Rule (ii) reads the LITERAL argument window, so a `quantity` smuggled
 *     through a local `const data = …` inside an ALLOWLISTED file is not caught
 *     (B25-OC3-4). The allowlisted files carry that by decision; every other
 *     file is caught by rule (i) regardless of spelling.
 *   - Rule (iii) reads literal text the same way: a nested relation write
 *     assembled through a variable (`data: nested`) is the same class.
 *   - The scan roots are stated, not universal. `launch-gate/` and `prisma/`
 *     sit outside them (B25-OC4-5; `prisma/seed-locations.ts` READS the column
 *     and nothing runs it); this pin does not police those directories.
 *   - A raw SQL string ASSEMBLED FROM PARTS or passed as a variable
 *     (`$executeRawUnsafe(sql)`) is not seen: the scan reads literal source
 *     text, and a statement that only exists at runtime has no source line.
 *     The multi-table belts (B25-QA-2) are keyword-case-SENSITIVE by decision,
 *     so a lower-case multi-table statement is the same class.
 *   - The ALIAS class (B25-FD1-1): `const p = tx.product; p.update(…)` and
 *     `tx['product'].update(…)` name no `.product.` chain and escape every rule.
 *     The delegate matcher tolerates LAYOUT — whitespace around both dots and
 *     before the paren, optional chaining (`?.`) and explicit type arguments
 *     (`update<T>(`), all self-tested below (B25-FD2-1/2); an alias is a
 *     different spelling, not a different layout, and is stated, not chased.
 *     `tx.product['update'](` and `.update.call(` are of the alias class.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

/** Every tree a `products` writer could legitimately live in. */
const SCANNED_DIRS = ['lib', 'app', 'components', 'mcp/src', 'scripts', 'concurrency-gate'];

/** `scripts/diagnostics/` READS the column on purpose (the d4 artifact). */
const EXCLUDED_DIRS = ['scripts/diagnostics'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.tsx']);

/**
 * The ONE delegate matcher for the PRISMA DELEGATE spellings (`.product.update(`
 * … `.product.upsert(`), case-SENSITIVE (the repo writes them lower-case and
 * nothing about a delegate call is case-ambiguous) and LAYOUT-tolerant
 * (B25-FD1-1, B25-FD2-1/2): whitespace around BOTH dots and before the paren,
 * an optional-chaining method dot (`product?.update(`) and explicit type
 * arguments (`update<Prisma.ProductUpdateArgs>(`) — because nothing normalises
 * source before this scan (no prettier hook is wired) and every one of those is
 * the same call. Shared by rule (i), rule (ii) and the per-file spellings so
 * the three can never disagree about what a delegate write looks like.
 */
const DELEGATE_WRITE_CALL =
  /\.\s*product\s*\??\.\s*(update|updateMany|create|createMany|upsert)\s*(?:<[^(]*>)?\s*\(/g;

/** EXPORTED FOR TEST. Every delegate write in `text`, with its canonical spelling label. */
export function delegateWriteHits(text: string): Array<{ index: number; spelling: string; op: string }> {
  const hits: Array<{ index: number; spelling: string; op: string }> = [];
  DELEGATE_WRITE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DELEGATE_WRITE_CALL.exec(text)) !== null) {
    hits.push({ index: match.index, spelling: `.product.${match[1]}(`, op: match[1] });
  }
  return hits;
}

/**
 * The RAW SQL spellings, case-INSENSITIVE (B25-FR1/F4). `update products set` is
 * the same statement as `UPDATE products SET`, and the literal match only ever
 * caught one of them. The optional `db`.`tbl` qualifier and the optional
 * backticks are what an engine trace and a hand-written statement differ by.
 */
const SQL_WRITE_PATTERNS = [
  { spelling: 'UPDATE products', pattern: /\bUPDATE\s+(?:`?\w+`?\s*\.\s*)?`?products`?\b/gi },
  {
    spelling: 'INSERT/REPLACE INTO products',
    pattern: /\b(?:INSERT|REPLACE)\s+INTO\s+(?:`?\w+`?\s*\.\s*)?`?products`?\b/gi,
  },
  // The split-literal belt (`'UPDATE ' + … + 'products SET'`). Case-SENSITIVE on the
  // keyword by decision (orchestrator, B25-FR1): the repo writes SQL keywords
  // upper-case, and the English "products set to …" occurs in prose AND in
  // user-visible admin copy — a belt that rewrites UI strings to stay green is
  // the wrong belt. A lower-case statement is still caught by the UPDATE regex.
  { spelling: 'products SET', pattern: /\bproducts`?\s+SET\b/g },
  // The MULTI-TABLE forms (B25-QA-2): MySQL's `UPDATE a JOIN products p ON … SET
  // p.quantity = …` and `UPDATE a, products p SET …` put another table first, so
  // none of the three belts above see them — and "resync the mirror from
  // product_locations" is exactly the statement somebody would reach for.
  // Keyword-case-SENSITIVE for the same reason as the belt above (an English
  // "update the products list and set …" is prose, not a statement).
  {
    spelling: 'UPDATE … products … SET (multi-table)',
    pattern: /\bUPDATE\b[^;]{0,300}?\bproducts`?\b[^;]{0,300}?\bSET\b/g,
  },
  { spelling: 'products <alias> SET', pattern: /\bproducts`?\s+\w+\s+SET\b/g },
] as const;

/**
 * THE ONE TOLERATED SQL LITERAL IN THE TREE. `concurrency-4.test.ts` carries the
 * engine trace this whole retirement was traced OUT of — a captured
 * `SHOW ENGINE INNODB STATUS` section whose query line is the retired cycle's own
 * `UPDATE … products SET quantity`. It is evidence, not a writer, and deleting it
 * would delete the proof. Tolerated by EXACT LINE PREFIX in EXACTLY that file:
 * any other SQL hit there is still an offender.
 */
const TOLERATED_SQL_FIXTURE_LINES = [
  {
    path: 'concurrency-gate/concurrency-4.test.ts',
    startsWith: '"UPDATE `concurrency_gate`.`products` SET `quantity` = (',
  },
] as const;

/** Every spelling of a `products` write, for the per-file pins below. */
function productWriteSpellings(text: string): string[] {
  const found: string[] = [];
  for (const hit of delegateWriteHits(text)) {
    if (!found.includes(hit.spelling)) found.push(hit.spelling);
  }
  for (const hit of sqlWriteHits(text)) {
    if (!found.includes(hit.spelling)) found.push(hit.spelling);
  }
  return found;
}

/**
 * EXPORTED FOR TEST (the self-tests at the bottom drive it on inline fixture
 * strings, never on the tree — an inversion case has to be a string nobody can
 * accidentally delete). Every raw-SQL `products` write in `text`, by index.
 */
export function sqlWriteHits(text: string): Array<{ index: number; spelling: string }> {
  const hits: Array<{ index: number; spelling: string }> = [];
  for (const { spelling, pattern } of SQL_WRITE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      hits.push({ index: match.index, spelling });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** ANY delegate's write call — rule (iii) walks these looking for a NESTED relation write. Same layout tolerance as the delegate matcher. */
const ANY_WRITE_CALL = /\.\s*\w+\s*\??\.\s*(update|updateMany|create|createMany|upsert)\s*(?:<[^(]*>)?\s*\(/g;

/** The nested operations that WRITE the related row (`connect` and `set` only re-point an FK). */
const NESTED_WRITE_OPS = 'update|upsert|updateMany|create|createMany|connectOrCreate';

/**
 * EXPORTED FOR TEST. Every nested-relation write, through a relation to
 * `Product`, whose nested window NAMES `quantity`. The relation names are the
 * caller's (read from `prisma/schema.prisma`), so this helper stays a matcher
 * and the schema stays the source of truth.
 */
export function nestedRelationWriteHits(
  text: string,
  relationNames: readonly string[],
): Array<{ index: number; relation: string; op: string }> {
  const hits: Array<{ index: number; relation: string; op: string }> = [];
  if (relationNames.length === 0) return hits;
  const relationWrite = new RegExp(
    `\\b(${relationNames.join('|')})\\s*:\\s*\\{\\s*(${NESTED_WRITE_OPS})\\b`,
    'g',
  );

  ANY_WRITE_CALL.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = ANY_WRITE_CALL.exec(text)) !== null) {
    const window = callWindow(text, text.indexOf('(', call.index));
    relationWrite.lastIndex = 0;
    let nested: RegExpExecArray | null;
    while ((nested = relationWrite.exec(window)) !== null) {
      // `callWindow` counts all three bracket kinds, so it walks a `{` as
      // happily as a `(`: the nested window is the relation's own object.
      const nestedWindow = callWindow(window, window.indexOf('{', nested.index));
      if (/\bquantity\b/.test(nestedWindow)) {
        hits.push({ index: call.index, relation: nested[1], op: nested[2] });
      }
    }
  }
  return hits;
}

/**
 * THE RELATION NAMES, READ FROM THE SCHEMA AT TEST TIME. Every field whose type
 * is `Product`, `Product?` or `Product[]` — today `deletedProducts`,
 * `createdProducts`, `reviewedProducts`, `product`, `resolvedProduct`,
 * `orderedProduct`, `products`, `internalProduct`, `priceSourceFor`. Parsed
 * rather than listed so a relation added tomorrow is policed tomorrow.
 */
function productRelationNames(): string[] {
  const schema = fs.readFileSync(path.join(REPO_ROOT, 'prisma/schema.prisma'), 'utf8');
  const names = new Set<string>();
  for (const line of schema.split('\n')) {
    const match = /^\s+(\w+)\s+Product(\?|\[\])?(\s|$)/.exec(line);
    if (match) names.add(match[1]);
  }
  return Array.from(names);
}

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

/** The WHOLE trimmed source line an index falls on — what the tolerated-fixture rule reads. */
function trimmedLineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

function isToleratedSqlFixture(sourcePath: string, line: string): boolean {
  return TOLERATED_SQL_FIXTURE_LINES.some(
    (tolerated) => tolerated.path === sourcePath && line.startsWith(tolerated.startsWith),
  );
}

let relationNames: string[];

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
  relationNames = productRelationNames();
});

describe('the loc-1 `products.quantity` mirror is retired (pack CB2.5a.3)', () => {
  it('sweeps a sane source surface (guards against discovery rot)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(300);
    // The roots are the ones the pack names, and the diagnostics tree — which
    // READS the column — is out.
    expect(sources.some((s) => s.path.startsWith('lib/'))).toBe(true);
    expect(sources.some((s) => s.path.startsWith('app/api/'))).toBe(true);
    expect(sources.some((s) => s.path.startsWith('components/'))).toBe(true);
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
      .filter((s) => productWriteSpellings(s.text).length > 0)
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
      for (const hit of delegateWriteHits(source.text)) {
        offenders.push(`  ${source.path}:${lineOf(source.text, hit.index)}  ${hit.spelling}`);
      }
      for (const hit of sqlWriteHits(source.text)) {
        // The gate's captured engine trace is evidence of the RETIRED cycle, by
        // exact line prefix in exactly that file — never a blanket file pardon.
        if (isToleratedSqlFixture(source.path, trimmedLineAt(source.text, hit.index))) continue;
        offenders.push(`  ${source.path}:${lineOf(source.text, hit.index)}  ${hit.spelling}`);
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
      // The SAME matcher rule (i) uses, consumed as a list (B25-FD2-3: never two
      // `exec` loops over one shared `g` regex object). `<T>` cannot contain `(`,
      // so the first paren after the hit is the call's own.
      for (const hit of delegateWriteHits(source.text)) {
        const openParen = source.text.indexOf('(', hit.index);
        const window = callWindow(source.text, openParen);
        if (/\bquantity\b/.test(window)) {
          offenders.push(`  ${source.path}:${lineOf(source.text, hit.index)}  ${hit.spelling}`);
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

  it('RULE (iii): no delegate reaches `products.quantity` through a NESTED relation write', () => {
    const offenders: string[] = [];
    for (const source of sources) {
      for (const hit of nestedRelationWriteHits(source.text, relationNames)) {
        offenders.push(
          `  ${source.path}:${lineOf(source.text, hit.index)}  ${hit.relation}: { ${hit.op} … quantity }`,
        );
      }
    }

    expect(
      offenders.length === 0
        ? ''
        : 'A NESTED RELATION write reaches `products.quantity`. Rules (i) and (ii) do not\n' +
            'see it — the delegate is not `.product.` — but the statement Prisma emits is the\n' +
            'same `UPDATE products SET quantity` the retirement deleted, and it takes the same\n' +
            'X lock on the product row inside a stock transaction. Write `product_locations`\n' +
            'through `applyStockDelta` instead:\n' +
            offenders.join('\n'),
    ).toBe('');
  });

  it('rule (iii) is not vacuous — the schema really names the relations it scans for', () => {
    // If the parse silently returned nothing, rule (iii) would pass on any tree.
    expect(relationNames).toContain('products');
    expect(relationNames).toContain('product');
    expect(relationNames.length).toBeGreaterThanOrEqual(5);
  });

  it('the ONE tolerated SQL fixture line is still there (the pardon is not vacuous)', () => {
    // Rule (i) pardons exactly this line. If the trace is ever deleted or
    // re-wrapped, the pardon must go with it rather than sit here covering a
    // line nobody can see any more.
    for (const tolerated of TOLERATED_SQL_FIXTURE_LINES) {
      const source = sources.find((s) => s.path === tolerated.path);
      expect(source).toBeDefined();
      const matching = source!.text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(tolerated.startsWith));
      expect(matching).toHaveLength(1);
      // And it really IS a hit the rule would otherwise report.
      expect(sqlWriteHits(matching[0]).length).toBeGreaterThan(0);
    }
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
    const matched = productWriteSpellings(booking!.text);
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
      expect(productWriteSpellings(text!)).toEqual([]);
    }
  });
});

// ===========================================================================
// THE MATCHERS, SELF-TESTED ON INLINE FIXTURES (B25-FR1/F4d).
//
// The inversion cases live HERE, as strings, never in the tree: a scanner
// proven only by "the tree is clean" is proven by nothing — it would pass just
// as well with every pattern deleted. Each fixture is one spelling the rules
// exist to catch, and one near-miss they must NOT catch.
// ===========================================================================

describe('delegateWriteHits — the Prisma delegate matcher', () => {
  it.each([
    ['await tx.product.update({ where: { id }, data: { quantity: 1 } })', 'the plain chain'],
    ['await tx.product\n  .update({ where: { id }, data: { quantity: { increment: delta } } })', 'a line-broken chain (B25-FD1-1)'],
    ['prisma.product .updateMany ({ data: { quantity: 0 } })', 'spaces around the dot and before the paren'],
    ['await tx.\n  product.update({ data: { quantity: 1 } })', 'a chain broken after the OBJECT dot (B25-FD2-1)'],
    ['tx.product?.update({ data: { quantity: 1 } })', 'optional chaining (B25-FD2-2)'],
    ['prisma.product.update<Prisma.ProductUpdateArgs>({ data: { quantity: 1 } })', 'explicit type arguments (B25-FD2-2)'],
    ['tx.product.upsert({ where: { id }, update: {}, create: { quantity: 0 } })', 'an upsert'],
  ])('catches %s (%s)', (fixture) => {
    expect(delegateWriteHits(fixture).length).toBeGreaterThan(0);
  });

  it.each([
    ['await tx.product.findUnique({ where: { id } })', 'a read'],
    ['await tx.product_locations.update({ where: { id }, data: { quantity: 1 } })', 'the COVERED delegate'],
    ['await tx.productMapping.update({ where: { id }, data: {} })', 'another delegate whose name starts with product'],
    ['await tx.productReorderConfig.upsert({ where: { id }, update: {}, create: {} })', 'the allowlisted reorder-config delegate'],
  ])('does NOT catch %s (%s)', (fixture) => {
    expect(delegateWriteHits(fixture)).toEqual([]);
  });

  it('labels every hit with the canonical spelling, whatever the layout', () => {
    expect(delegateWriteHits('tx.product\n  .update(').map((h) => h.spelling)).toEqual(['.product.update(']);
  });
});

describe('sqlWriteHits — the raw-SQL matchers', () => {
  it.each([
    ['UPDATE `products` SET quantity = 1', 'the backticked table'],
    ['update products set quantity=quantity+1', 'all lower-case'],
    ['INSERT INTO inventory.products (id) VALUES (1)', 'a schema-qualified INSERT'],
    ['REPLACE INTO products (id, quantity) VALUES (1, 0)', 'REPLACE INTO'],
    [
      'UPDATE product_locations pl JOIN products p ON p.id = pl.productId SET p.quantity = pl.quantity WHERE pl.locationId = 1',
      'a multi-table UPDATE with products second (B25-QA-2)',
    ],
    ['UPDATE inventory_logs il, products p SET p.quantity = 0 WHERE il.productId = p.id', 'the comma-join form (B25-QA-2)'],
  ])('catches %s (%s)', (fixture) => {
    expect(sqlWriteHits(fixture).length).toBeGreaterThan(0);
  });

  it.each([
    ['UPDATE product_locations SET quantity = 1', 'the COVERED table is the right one to write'],
    ['UPDATE product_locations pl SET pl.quantity = 1 WHERE pl.productId = 2', 'an aliased covered-table UPDATE'],
    ['SELECT quantity FROM products', 'a read is not a write'],
    ['// Update the products list first and then set the flag on each row', 'English prose with the three words in order'],
  ])('does NOT catch %s (%s)', (fixture) => {
    expect(sqlWriteHits(fixture)).toEqual([]);
  });
});

describe('nestedRelationWriteHits — the relation matcher', () => {
  const RELATIONS = ['products', 'product', 'internalProduct'];

  it.each([
    [
      'tx.product_locations.update({ where: { id: 1 }, data: { products: { update: { quantity: { increment: 1 } } } } })',
      'a nested update through the covered row',
    ],
    [
      'tx.inventory_logs.create({ data: { products: { connectOrCreate: { where: { id: 1 }, create: { quantity: 0 } } } } })',
      'a connectOrCreate that mints a quantity',
    ],
  ])('catches %s (%s)', (fixture) => {
    expect(nestedRelationWriteHits(fixture, RELATIONS).length).toBeGreaterThan(0);
  });

  it.each([
    [
      'tx.product_locations.update({ where: { id: 1 }, data: { quantity: { increment: 1 }, products: { connect: { id: 1 } } } })',
      "product_locations' OWN quantity beside a plain connect",
    ],
    [
      'tx.product_locations.update({ where: { id: 1 }, data: { products: { update: { name: "x" } } } })',
      'a nested write that does not name quantity',
    ],
  ])('does NOT catch %s (%s)', (fixture) => {
    expect(nestedRelationWriteHits(fixture, RELATIONS)).toEqual([]);
  });

  it('an empty relation list matches nothing rather than everything', () => {
    expect(
      nestedRelationWriteHits('tx.x.update({ data: { products: { update: { quantity: 1 } } } })', []),
    ).toEqual([]);
  });
});
