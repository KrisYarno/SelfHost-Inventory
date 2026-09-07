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
 *   RULE (i)   No file OUTSIDE the allowlist contains a `products` DELEGATE
 *              writer, and NO file at all — allowlisted or not — contains a
 *              raw-SQL `products` write (B25-CX-1: the allowlist licenses
 *              delegate writers of non-stock fields, never raw SQL).
 *   RULE (ii)  Every ALLOWLISTED file's writer CALL WINDOWS — the argument
 *              span as TypeScript's own parser reads it (B25-CX2) — never name
 *              `quantity`.
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
 *     so a lower-case multi-table statement is the same class; their window is
 *     300 chars with no `;` inside, so a JOIN whose ON clause outruns it, or a
 *     literal `;` in the statement text, escapes (B25-FD3-5). By design they
 *     also FLAG a multi-table UPDATE that merely JOINs `products` to filter a
 *     `product_locations` write — a rewrite (join in a subquery), not a hole.
 *   - The ALIAS class (B25-FD1-1): `const p = tx.product; p.update(…)` and
 *     `p.update(…)` names no `.product.` chain and escapes every rule
 *     (`tx['product'].update(…)` is now read by the parser — B25-CX2).
 *     The delegate matcher tolerates LAYOUT — whitespace around both dots and
 *     before the paren, optional chaining (`?.`) and explicit type arguments
 *     (`update<T>(`), all self-tested below (B25-FD2-1/2); an alias is a
 *     different spelling, not a different layout, and is stated, not chased.
 *     `tx.product['update'](` and `.update.call(` are of the alias class, and
 *     so is a CONDITIONAL delegate or relation object (B25-FD4-2):
 *     `(cond ? tx.product : tx.other).update(` reads as no delegate, and
 *     `products: cond ? { update: { quantity } } : undefined` is not an
 *     object literal — the parser reports neither; stated, not chased.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

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
 * the same call. This is the SPELLING matcher: rule (i)'s belt, the per-file
 * spellings, and the raw-text fallback of rules (ii)/(iii) (a spelling the
 * parser cannot see is an offender). The WINDOWS are the parser's (below).
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
    // `(?<!\bFOR\s)`: the house prose writes `FOR UPDATE` in comments, and
    // four such comments already sit within 300 chars of the word `products`
    // (B25-FD3-4) — one upper-case SET added to any of them would have tripped
    // an unanchored belt. A statement never starts with `FOR UPDATE`.
    pattern: /(?<!\bFOR\s)\bUPDATE\b[^;]{0,300}?\bproducts`?\b[^;]{0,300}?\bSET\b/g,
  },
  { spelling: 'products <alias> SET', pattern: /\bproducts`?\s+\w+\s+SET\b/g },
] as const;

/**
 * THE ONE TOLERATED SQL LITERAL IN THE TREE. `concurrency-4.test.ts` carries the
 * engine trace this whole retirement was traced OUT of — a captured
 * `SHOW ENGINE INNODB STATUS` section whose query line is the retired cycle's own
 * `UPDATE … products SET quantity`. It is evidence, not a writer, and deleting it
 * would delete the proof. Tolerated by EXACT LINE in EXACTLY that file
 * (B25-CX-3 — a prefix pardoned anything appended): any other SQL hit there is
 * still an offender.
 */
const TOLERATED_SQL_FIXTURE_LINES = [
  {
    path: 'concurrency-gate/concurrency-4.test.ts',
    // EXACT line (B25-CX-3): a prefix pardoned anything appended to the line.
    line: '"UPDATE `concurrency_gate`.`products` SET `quantity` = (`concurrency_gate`.`products`.`quantity` + 1) WHERE (`concurrency_gate`.`products`.`id` IN (9101) AND (`concurrency_gate`.`products`.`id` = 9101 AND 1=1))",',
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
  rel = 'inline.ts',
  parsed?: ts.SourceFile,
): Array<{ index: number; relation: string; op: string }> {
  const hits: Array<{ index: number; relation: string; op: string }> = [];
  if (relationNames.length === 0) return hits;
  const relations = new Set(relationNames);
  const nestedOps = new Set(NESTED_WRITE_OPS.split('|'));
  for (const w of writeCallWindows(rel, text, parsed)) {
    const visit = (node: ts.Node): void => {
      // B25-CX3-1: `products: { update: … } as const` is the same object — unwrap.
      const init = ts.isPropertyAssignment(node) ? unwrap(node.initializer) : null;
      if (ts.isPropertyAssignment(node) && init !== null && ts.isObjectLiteralExpression(init)) {
        const relation = propertyName(node.name);
        if (relation !== null && relations.has(relation)) {
          for (const inner of init.properties) {
            const op = inner.name ? propertyName(inner.name) : null;
            if (op !== null && nestedOps.has(op)) {
              // The nested WRITE's own text — `product_locations`' own `quantity`
              // beside a plain `connect` is outside it.
              const nested = text.slice(init.pos, init.end);
              if (/\bquantity\b/.test(nested)) hits.push({ index: w.index, relation, op });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    w.call.arguments.forEach(visit);
  }
  return hits;
}

/**
 * SPELLINGS THE PARSER CANNOT SEE (B25-CX3-2). An AST-only scan is blind to a
 * write inside a string (`eval("tx.product.update({…quantity…})")`) or a
 * commented-out call. The raw text is not: every product-write spelling
 * (rule (i)'s regex) and every FIRST-KEY nested-relation-write spelling
 * (`<relation>: { <op>` — B25-FD4-3: a spelling whose op is not the first key
 * is the parser path's to see) whose offset falls OUTSIDE every parser-
 * recognised Prisma write call (a call on a NAMED delegate — B25-FD4-4) is
 * reported as an offender — conservatively, without a window and WITHOUT
 * asking for `quantity`: a spelling nobody can execute as code is a rewrite
 * (comments are prose the pack owns), and one that CAN be executed (`eval`) is
 * exactly what this pin exists to refuse. The one ordinary shape this reds by
 * design (B25-FD4-1): a MOCK or a TYPE LITERAL outside any call whose first key
 * under a relation name is a write op (`product: { update: jest.fn() }`) —
 * move it into a call or rename the key; the failure direction is a loud red,
 * never a missed write.
 */
export function unseenWriteSpellings(
  rel: string,
  text: string,
  relationNames: readonly string[],
  parsed?: ts.SourceFile,
): Array<{ index: number; spelling: string }> {
  const sf = parsed ?? parseSource(rel, text);
  // Only calls on a NAMED delegate count as "seen" (B25-FD4-4): an `.update(`
  // on some other object must not hide a spelling nested in its arguments.
  const spans = writeCallWindows(rel, text, sf)
    .filter((w) => w.delegate !== null)
    .map((w) => [w.call.getStart(sf), w.call.end] as const);
  const inside = (i: number): boolean => spans.some(([s, e]) => i >= s && i < e);
  const found: Array<{ index: number; spelling: string }> = [];
  for (const hit of delegateWriteHits(text)) {
    if (!inside(hit.index)) found.push({ index: hit.index, spelling: hit.spelling });
  }
  if (relationNames.length > 0) {
    const relationWrite = new RegExp(`\\b(${relationNames.join('|')})\\s*:\\s*\\{\\s*(${NESTED_WRITE_OPS})\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = relationWrite.exec(text)) !== null) {
      if (!inside(m.index)) found.push({ index: m.index, spelling: `${m[1]}: { ${m[2]}` });
    }
  }
  return found;
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
  /** Parsed ONCE (B25-CX3 (d)): every rule reads the same tree. */
  sf: ts.SourceFile;
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
 * THE ARGUMENT WINDOWS ARE THE PARSER'S (B25-CX2-1/2/3 — the third and last
 * shape of this walker). A character walker by brace depth was defeated by a
 * regex literal (`/[}}]/`), then, taught regex literals, by a regex after a
 * keyword (`typeof /}}\)/`), a nested template literal, and a division after a
 * block comment. TypeScript's own parser (`ts.createSourceFile`: syntax only —
 * no type-check, no module load, error-tolerant) already knows where every
 * call's arguments begin and end, so the window is its span, RAW (comments
 * included, because what the rules ask is whether the call NAMES the column).
 */
const WRITE_OPS = new Set(['update', 'updateMany', 'create', 'createMany', 'upsert']);

function parseSource(rel: string, text: string): ts.SourceFile {
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : rel.endsWith('.js')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, kind);
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // `['products']: { update: … }` (B25-CX3, the computed spelling).
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
  return null;
}

/**
 * Strip the wrappers that change nothing at runtime (B25-CX3-1): parentheses,
 * `as T`, `satisfies T`, the postfix `!`, the angle-bracket assertion. A relation
 * object written `{ update: { quantity } } as const` is the same object.
 */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
      e = e.expression;
      continue;
    }
    return e;
  }
}

/** The parser's own syntax diagnostics (a private field, but the only one without building a Program). */
function parseDiagnostics(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

export interface WriteCallWindow {
  /** Character offset of the call (for line reporting). */
  index: number;
  op: string;
  /** The delegate the op is called on (`product`, `product_locations`, …), by name or by string index (`tx['product']`); null if unreadable. */
  delegate: string | null;
  /** The raw text of the call's arguments. */
  window: string;
  call: ts.CallExpression;
}

/** EXPORTED FOR TEST. Every `<x>.<delegate>.<op>(…)` write call in `text`, with its argument window. */
export function writeCallWindows(rel: string, text: string, parsed?: ts.SourceFile): WriteCallWindow[] {
  const sf = parsed ?? parseSource(rel, text);
  const found: WriteCallWindow[] = [];
  const visit = (node: ts.Node): void => {
    const callee = ts.isCallExpression(node) ? unwrap(node.expression) : null;
    if (ts.isCallExpression(node) && callee !== null && ts.isPropertyAccessExpression(callee)) {
      const op = callee.name.text;
      if (WRITE_OPS.has(op)) {
        // `(tx.product as any).update(`, `(tx.product).update(` — the same delegate.
        const inner = unwrap(callee.expression);
        let delegate: string | null = null;
        if (ts.isPropertyAccessExpression(inner)) delegate = inner.name.text;
        else if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression)) {
          delegate = inner.argumentExpression.text;
        }
        const window = node.arguments.length === 0 ? '' : text.slice(node.arguments.pos, node.end);
        found.push({ index: node.getStart(sf), op, delegate, window, call: node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
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
    (tolerated) => tolerated.path === sourcePath && line === tolerated.line,
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
      .map(({ rel, text }) => ({ path: rel, text, sf: parseSource(rel, text) })),
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

  it('every scanned file PARSES without syntax diagnostics (B25-CX3-3: a malformed file has no reliable spans)', () => {
    const bad = sources
      .map((s) => ({ path: s.path, diagnostics: parseDiagnostics(s.sf) }))
      .filter((d) => d.diagnostics.length > 0)
      .map((d) => `  ${d.path}: ${d.diagnostics.slice(0, 2).map((x) => ts.flattenDiagnosticMessageText(x.messageText, ' ')).join(' | ')}`);
    expect(bad.length === 0 ? '' : 'The parser could not read these files cleanly, so rules (ii)/(iii) have no reliable\nwindows there. Fix the syntax (`.js` files are parsed with the JSX language variant, so a\nJSX-ambiguous construct counts too — B25-FD4-6):\n' + bad.join('\n')).toBe('');
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
      // The allowlist licenses DELEGATE writers (non-stock product fields) —
      // never raw SQL on `products` (B25-CX-1: an allowlisted file could add
      // `$executeRawUnsafe("UPDATE products SET quantity = 0")` and stay green).
      if (!ALLOWED.has(source.path)) {
        const seen = new Set<number>();
        for (const hit of delegateWriteHits(source.text)) {
          const line = lineOf(source.text, hit.index);
          seen.add(line);
          offenders.push(`  ${source.path}:${line}  ${hit.spelling}`);
        }
        // The PARSER's view as well (B25-CX2): a `tx['product'].update(` or any
        // layout the spelling regex does not anticipate is still a product write.
        for (const w of writeCallWindows(source.path, source.text, source.sf)) {
          if (w.delegate !== 'product') continue;
          const line = lineOf(source.text, w.index);
          if (seen.has(line)) continue;
          seen.add(line);
          offenders.push(`  ${source.path}:${line}  .product.${w.op}( (parser)`);
        }
      }
      for (const hit of sqlWriteHits(source.text)) {
        // The gate's captured engine trace is evidence of the RETIRED cycle, by
        // EXACT line in exactly that file — never a blanket file pardon.
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
      // The PARSER's windows (B25-CX2): exact spans, whatever the argument holds.
      for (const w of writeCallWindows(source.path, source.text, source.sf)) {
        if (w.delegate !== 'product') continue;
        if (/\bquantity\b/.test(w.window)) {
          offenders.push(`  ${source.path}:${lineOf(source.text, w.index)}  .product.${w.op}(`);
        }
      }
      // And the spellings the parser cannot see (B25-CX3-2): a string, a
      // comment, an eval — no window, so reported outright.
      for (const u of unseenWriteSpellings(source.path, source.text, [], source.sf)) {
        offenders.push(
          `  ${source.path}:${lineOf(source.text, u.index)}  ${u.spelling} (outside any parsed Prisma call — a string, a comment, an eval, a mock or a type literal; move it into a call or rename the key)`,
        );
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
      for (const hit of nestedRelationWriteHits(source.text, relationNames, source.path, source.sf)) {
        offenders.push(
          `  ${source.path}:${lineOf(source.text, hit.index)}  ${hit.relation}: { ${hit.op} … quantity }`,
        );
      }
      // The nested-write SPELLING outside any parsed call (B25-CX3-2).
      for (const u of unseenWriteSpellings(source.path, source.text, relationNames, source.sf)) {
        if (!u.spelling.includes(': {')) continue; // the delegate spellings are rule (i)/(ii)'s
        offenders.push(`  ${source.path}:${lineOf(source.text, u.index)}  ${u.spelling} (outside any parsed call — a string, a comment or an eval)`);
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
        .filter((line) => line === tolerated.line);
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

describe('writeCallWindows — the argument windows are the PARSER\'s (B25-CX-2, B25-CX2-1/2/3)', () => {
  const productWindow = (src: string): string => {
    const w = writeCallWindows('inline.ts', src).filter((x) => x.delegate === 'product');
    expect(w).toHaveLength(1);
    return w[0].window;
  };
  it.each([
    ['tx.product.update({ where: { name: /[}}]/.test(input) ? "a" : "b" }, data: { quantity: { increment: 1 } } })', "codex's first smuggle: two closing braces inside a regex class"],
    ['tx.product.update({ where: { id: typeof /}}\\)/ === "object" ? 1 : 2 }, data: { quantity: 1 } })', 'a regex after a keyword (B25-CX2-1)'],
    ['tx.product.update({ where: { id: (() => { return /}\\)}}\\)/.test(s) ? 1 : 2; })() }, data: { quantity: 1 } })', 'a regex after return (B25-CX2-1)'],
    ['tx.product.update({ where: { name: `a ${`}})`} z` }, data: { quantity: 1 } })', 'a NESTED template literal (B25-CX2-2)'],
    ['tx.product.update({ where: { id: /\\/[)]\\//.test(s) ? 1 : 2 }, data: { quantity: 1 } })', 'escaped slashes and a paren in a class'],
    ['tx.product.update({ where: { id }, data: { half: a / b / c, quantity: total / 2 } })', 'divisions are not regexes'],
    ['tx.product.update({ where: { id }, data: { note: `a ${x} }`, quantity: 1 } })', 'a template literal with a brace'],
    ["tx['product'].update({ where: { id }, data: { quantity: 1 } })", 'the string-index delegate spelling'],
    ['prisma.product?.update<Prisma.ProductUpdateArgs>({ where: { id }, data: { quantity: 1 } })', 'optional chaining + type arguments'],
  ])('keeps `quantity` inside the window for %s (%s)', (src) => {
    expect(/\bquantity\b/.test(productWindow(src))).toBe(true);
  });

  it.each([
    ['tx.product.update({ where: { id: total /* units */ / 2 }, data: { name: "ok" } });\nconst quantity = 0;', 'a division after a block comment (B25-CX2-3: the walker overran into the next statement)'],
    ['tx.product.update({ where: { id } })\nconst quantity = 1;', 'the window ends at the call'],
    ['tx.product.update({ where: { id: x /= 2 }, data: { name: "ok" } }); let quantity;', 'a compound division'],
  ])('ends the window at the call for %s (%s)', (src) => {
    expect(/\bquantity\b/.test(productWindow(src))).toBe(false);
  });

  it.each([
    ['(tx.product as any).update({ where: { id }, data: { quantity: 1 } })', 'a callee wrapped in `as any` (B25-CX3)'],
    ['(tx.product).update({ where: { id }, data: { quantity: 1 } })', 'a parenthesised delegate'],
    ['(tx.product.update)({ where: { id }, data: { quantity: 1 } })', 'a parenthesised callee'],
    ['(tx.product satisfies unknown)!.update({ where: { id }, data: { quantity: 1 } })', 'satisfies + non-null'],
  ])('reads the delegate through runtime-neutral wrappers for %s (%s)', (src) => {
    expect(/\bquantity\b/.test(productWindow(src))).toBe(true);
  });

  it('a malformed file carries parse diagnostics (the diagnostics pin is not vacuous)', () => {
    const sf = parseSource('inline.ts', 'const a = `unclosed; tx.product.update({ data: { quantity: 1 } })');
    expect(parseDiagnostics(sf).length).toBeGreaterThan(0);
  });

  it('reads the delegate by name or by string index, and ignores non-write ops', () => {
    const windows = writeCallWindows('inline.ts', 'a.product.findMany({}); b.product_locations.update({ data: { quantity: 1 } }); c["product"].upsert({});');
    expect(windows.map((w) => [w.delegate, w.op])).toEqual([['product_locations', 'update'], ['product', 'upsert']]);
  });
});

describe('the tolerated SQL fixture is pardoned by EXACT line (B25-CX-3)', () => {
  it('an appended statement on the fixture line is NOT pardoned', () => {
    const [tolerated] = TOLERATED_SQL_FIXTURE_LINES;
    expect(isToleratedSqlFixture(tolerated.path, tolerated.line)).toBe(true);
    expect(isToleratedSqlFixture(tolerated.path, tolerated.line + ' tx.$executeRawUnsafe("UPDATE products SET quantity = 7")')).toBe(false);
    expect(isToleratedSqlFixture('lib/inventory.ts', tolerated.line)).toBe(false);
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
    [
      '// step 6b: `SELECT … FOR UPDATE` on the row; see lib/products/decline.ts — then SET the flag',
      'house prose: FOR UPDATE near the word products and an upper-case SET (B25-FD3-4)',
    ],
    ['UPDATE product_locations SET quantity = 1 WHERE productId IN (SELECT id FROM products)', 'a covered-table UPDATE filtering on products'],
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

  it.each([
    ['tx.product_locations.update({ where: { id: 1 }, data: { products: { update: { quantity: { increment: 1 } } } as const } })', 'the relation object behind `as const` (B25-CX3-1)'],
    ['tx.product_locations.update({ where: { id: 1 }, data: { products: ({ update: { quantity: 1 } } satisfies unknown)! } })', 'satisfies + non-null'],
    ["tx.product_locations.update({ where: { id: 1 }, data: { ['products']: { update: { quantity: 1 } } } })", 'a computed relation name'],
  ])('catches the wrapped relation write %s (%s)', (fixture) => {
    expect(nestedRelationWriteHits(fixture, RELATIONS).length).toBeGreaterThan(0);
  });

  it('spellings the parser cannot see are reported outright (B25-CX3-2)', () => {
    const evalString = 'await eval("tx.product_locations.update({where:{id:1},data:{products:{update:{quantity:1}}}})");';
    expect(unseenWriteSpellings('inline.ts', evalString, RELATIONS).map((u) => u.spelling)).toEqual(['products: { update']);
    const commented = '// tx.product.update({ data: { quantity: 1 } })\ntx.product.findMany({});';
    expect(unseenWriteSpellings('inline.ts', commented, RELATIONS).map((u) => u.spelling)).toEqual(['.product.update(']);
    const seen = 'tx.product.update({ data: { name: "x" } }); tx.product_locations.update({ data: { products: { update: { name: "y" } } } });';
    expect(unseenWriteSpellings('inline.ts', seen, RELATIONS)).toEqual([]);
  });

  it('an empty relation list matches nothing rather than everything', () => {
    expect(
      nestedRelationWriteHits('tx.x.update({ data: { products: { update: { quantity: 1 } } } })', []),
    ).toEqual([]);
  });
});
