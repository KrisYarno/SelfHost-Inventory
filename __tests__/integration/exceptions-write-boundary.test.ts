// @jest-environment node
/**
 * W1-2c — the EXCEPTIONS WRITE BOUNDARY gate (contract pack REV-3 T1, binding).
 *
 * `inventory_exceptions` rows are written ONLY by explicitly-mutating routes.
 * NO GET writes one, and NO assistant tool ever writes one — the register is
 * zero-business-writes adjacent, and a read surface that quietly raises rows
 * would make "nothing happened just by looking" false.
 *
 * The gate is a SOURCE SCAN, deliberately, in the same spirit as
 * change-tracking-coverage.test.ts: it never loads a module and never runs a
 * handler, so it cannot be fooled by a mock and cannot be flaked by an import
 * chain. Four assertions carry it:
 *
 *   1. ONE WRITER   — `inventoryException.create/update/upsert/delete...` appears
 *      in exactly one source file: lib/exceptions/write.ts. Everything else must
 *      go through it, so the lifecycle rules cannot be re-implemented wrongly.
 *   2. NAMED CALLERS — the files importing that writer are EXACTLY the list
 *      below. Adding a caller is a deliberate edit to this file, reviewed.
 *   3. NO GET-ONLY CALLER — every listed caller is a route that exports a
 *      mutating HTTP method. A GET-only route cannot be on the list.
 *   4. NO GET HANDLER WRITES — inside a route that has both, the GET segment
 *      must not touch the writer or the delegate.
 *
 * KNOWN LIMIT (documented, not engineered away — same class as the change-
 * tracking gate's ER-B5): segment slicing is export-boundary based, and a GET
 * that reached a write through a THIRD module would be invisible to (4).
 * Assertion (2) is what actually closes that: no third module may import the
 * writer at all without appearing here.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

/** The one module allowed to touch the delegate. */
const WRITER_MODULE = 'lib/exceptions/write.ts';
/** How callers reach it. */
const WRITER_SPECIFIER = '@/lib/exceptions/write';

/** Source trees the gate sweeps (test files live outside them by construction). */
const SCANNED_DIRS = ['app', 'lib', 'components', 'hooks'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Every file allowed to import the exceptions writer.
 *
 * Entries are ROUTE files on purpose: the boundary is stated at the HTTP verb,
 * so a caller that is not a route (a shared lib, a server component) cannot be
 * added without consciously re-opening this rule. W1-3b adds the graduate route
 * plus admin/products/[id]/approve + decline (pending-with-stock resolution and
 * the non-admin cost-differs row); W3 adds its admin recompute POST. Each lands
 * with its own entry, in its own wave.
 */
interface WriterCaller {
  path: string;
  reason: string;
}

const ALLOWED_WRITER_CALLERS: WriterCaller[] = [
  {
    path: 'app/api/staging-items/[id]/count/route.ts',
    reason:
      'W1-2c: the count endpoint is where a receiving discrepancy becomes known, so it ' +
      'raises / auto-resolves recv-discrepancy in the same transaction as the count write',
  },
  {
    path: 'app/api/staging-items/[id]/graduate/route.ts',
    reason:
      'W1-3b: graduation is where both W1 register rows are BORN — cost-differs (a ' +
      'non-admin received goods at a cost that disagrees with the product, and may not ' +
      'edit the price) and pending-with-stock (a non-admin minted a product, so real ' +
      'units now sit against an unapproved catalog entry). Both are written through the ' +
      "graduation's own transaction via its onRecord hook, so a rolled-back graduation " +
      'can never strand one',
  },
  {
    path: 'app/api/admin/products/[id]/approve/route.ts',
    reason:
      'W1-3b: approving the product is one of the two acts that make pending-with-stock ' +
      'false, so the resolution is written inside the approval transaction (T1 LIFECYCLE)',
  },
  {
    path: 'app/api/admin/products/[id]/decline/route.ts',
    reason:
      'W1-3b: declining reverses the stock, so pending-with-stock is resolved inside ' +
      "declineProduct's transaction — the register never outlives the units it names",
  },
];

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Any write call against the Prisma delegate, on prisma or on a tx client. */
const DELEGATE_WRITE =
  /\binventoryException\s*\.\s*(create|createMany|createManyAndReturn|upsert|update|updateMany|delete|deleteMany)\b/;
/** Any mention at all — used for the read surfaces that must stay clean. */
const DELEGATE_MENTION = /\binventoryException\b/;

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

/** Split a route source into per-exported-handler segments (house export style). */
function handlerSegments(sourceText: string): Map<string, string> {
  const re = /^export\s+(?:const|async\s+function)\s+(POST|PUT|PATCH|DELETE|GET)\b/gm;
  const hits: Array<{ method: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText)) !== null) hits.push({ method: m[1], index: m.index });
  const segments = new Map<string, string>();
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : sourceText.length;
    segments.set(h.method, sourceText.slice(h.index, end));
  });
  return segments;
}

interface SourceFile {
  path: string;
  text: string;
}

let sources: SourceFile[];

beforeAll(() => {
  sources = SCANNED_DIRS.flatMap((dir) =>
    walk(path.join(REPO_ROOT, dir)).map((abs) => ({
      path: toRepoPath(abs),
      text: fs.readFileSync(abs, 'utf8'),
    })),
  );
});

describe('exceptions write boundary — ONE writer', () => {
  it('sweeps a sane source surface (guards against discovery rot)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(300);
    expect(sources.some((s) => s.path === WRITER_MODULE)).toBe(true);
  });

  it('only lib/exceptions/write.ts calls the inventoryException delegate', () => {
    const offenders = sources
      .filter((s) => s.path !== WRITER_MODULE && DELEGATE_WRITE.test(s.text))
      .map((s) => `  ${s.path}`);

    expect(
      offenders.length === 0
        ? ''
        : `Files writing inventory_exceptions directly. The lifecycle (upsert-on-key,\n` +
            `reopen-on-recurrence, idempotent resolve) lives in ${WRITER_MODULE} and nowhere\n` +
            `else — call upsertException / resolveException instead:\n` +
            offenders.join('\n'),
    ).toBe('');
  });

  it('the writer module itself really does write (the gate is not vacuous)', () => {
    const writer = sources.find((s) => s.path === WRITER_MODULE);
    expect(writer).toBeDefined();
    expect(DELEGATE_WRITE.test(writer!.text)).toBe(true);
  });
});

describe('exceptions write boundary — NAMED callers only', () => {
  const importers = () =>
    sources.filter((s) => s.path !== WRITER_MODULE && s.text.includes(WRITER_SPECIFIER)).map((s) => s.path);

  it('the files importing the writer are exactly the allow list', () => {
    expect(importers().sort()).toEqual(ALLOWED_WRITER_CALLERS.map((c) => c.path).sort());
  });

  it('allow-list hygiene: unique, existing, reasoned — and each really imports the writer', () => {
    const seen = new Set<string>();
    for (const caller of ALLOWED_WRITER_CALLERS) {
      expect(seen.has(caller.path)).toBe(false);
      seen.add(caller.path);
      expect(fs.existsSync(path.join(REPO_ROOT, caller.path))).toBe(true);
      expect(caller.reason.trim().length).toBeGreaterThan(0);
      const text = fs.readFileSync(path.join(REPO_ROOT, caller.path), 'utf8');
      expect(text.includes(WRITER_SPECIFIER)).toBe(true);
    }
  });

  it('NO GET-ONLY caller: every listed caller is a route exporting a mutating method', () => {
    const getOnly: string[] = [];
    for (const caller of ALLOWED_WRITER_CALLERS) {
      expect(caller.path.endsWith('/route.ts')).toBe(true);
      const segments = handlerSegments(fs.readFileSync(path.join(REPO_ROOT, caller.path), 'utf8'));
      const mutating = MUTATING_METHODS.filter((m) => segments.has(m));
      if (mutating.length === 0) getOnly.push(`  ${caller.path}`);
    }
    expect(
      getOnly.length === 0
        ? ''
        : `Allow-listed exception writers with NO mutating HTTP method. Exception rows are\n` +
            `written only by explicitly-mutating routes (pack REV-3 T1 WRITE BOUNDARY):\n` +
            getOnly.join('\n'),
    ).toBe('');
  });
});

describe('exceptions write boundary — no GET handler writes', () => {
  it('no GET segment anywhere touches the writer or the delegate', () => {
    const offenders: string[] = [];
    for (const source of sources) {
      if (!source.path.endsWith('/route.ts')) continue;
      const seg = handlerSegments(source.text).get('GET');
      if (!seg) continue;
      if (
        DELEGATE_MENTION.test(seg) ||
        /\b(upsertException|resolveException)\s*\(/.test(seg)
      ) {
        offenders.push(`  ${source.path}`);
      }
    }
    expect(
      offenders.length === 0
        ? ''
        : `GET handlers referencing inventory_exceptions writes. A read must never raise a\n` +
            `row (pack REV-3 T1 WRITE BOUNDARY) — move the write to a mutating verb:\n` +
            offenders.join('\n'),
    ).toBe('');
  });

  it('the segment slicer is not vacuous — it finds the count route POST', () => {
    const countRoute = path.join(REPO_ROOT, 'app/api/staging-items/[id]/count/route.ts');
    const segments = handlerSegments(fs.readFileSync(countRoute, 'utf8'));
    expect(segments.has('POST')).toBe(true);
    expect(/\b(upsertException|resolveException)\s*\(/.test(segments.get('POST')!)).toBe(true);
  });
});

describe('exceptions write boundary — the assistant surface stays out entirely', () => {
  it('no lib/assistant module mentions the exceptions table or its writer', () => {
    const offenders = sources
      .filter((s) => s.path.startsWith('lib/assistant/'))
      .filter((s) => DELEGATE_MENTION.test(s.text) || s.text.includes(WRITER_SPECIFIER))
      .map((s) => `  ${s.path}`);

    expect(
      offenders.length === 0
        ? ''
        : `Assistant modules referencing inventory_exceptions. The assistant surface is\n` +
            `read-only (zero business writes) and never raises an exception row:\n` +
            offenders.join('\n'),
    ).toBe('');
  });
});
