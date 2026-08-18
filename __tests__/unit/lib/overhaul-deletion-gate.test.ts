/**
 * @jest-environment node
 *
 * THE OVERHAUL DELETION GATE (Receiving/Labeling overhaul, contract pack C6.3).
 *
 * M6 retired the pre-staging flow and the freight calculator OUTRIGHT — D8
 * LITERAL, not a deprecation. A retirement that is only half-done is worse than
 * one not started: a route left mounted keeps writing rows the new flow cannot
 * read, and a dialog left importable comes back the first time somebody reaches
 * for "the create shipment thing". So the deletion is pinned, in code, by TWO
 * INDEPENDENT CHECKS:
 *
 *   1. ABSENCE.   Every exact path in C6.1 (19 production modules) and C6.2 (20
 *      suites) is gone from disk. This is the literal list, kept literal.
 *   2. NO REACH.  Nothing under app / components / hooks / lib / __tests__ /
 *      concurrency-gate / launch-gate / scripts still REACHES one — by static
 *      import, dynamic import, `require`, or `jest.mock` specifier, aliased
 *      (`@/…`) or relative. Separately: no live `/api/staging-items` URL, no
 *      live `/api/inbound-shipments/<id>/costs` URL, and no `["staging-items"]`
 *      react-query key.
 *
 * The two checks are independent on purpose. (1) alone would pass while a
 * dangling import broke the build; (2) alone would pass on a codebase where the
 * files were still sitting there, unimported, waiting.
 *
 * COMMENTS ARE NOT REACH. The scan strips comments before matching, because the
 * history of what was deleted is worth writing down — `lib/change-tracking.ts`
 * explains which route used to emit LINK/UNLINK, `lib/validation/supply-orders.ts`
 * names the validator it superseded, and the audit taxonomy still carries
 * STAGING_GRADUATE so stored history stays readable. Prose about a dead module
 * is documentation; an import of it is a defect.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();

/** C6.1 — the production modules M6 deletes, exactly. */
const DELETED_PRODUCTION = [
  'lib/validation/inbound-shipment.ts',
  'lib/shipments/cost-allocation.ts',
  'components/receiving/freight-calculator-panel.tsx',
  'app/api/inbound-shipments/[id]/costs/route.ts',
  'components/receiving/create-shipment-dialog.tsx',
  'lib/staging/graduate.ts',
  'lib/staging/queries.ts',
  'components/staging/create-staging-dialog.tsx',
  'components/staging/graduate-dialog.tsx',
  'components/staging/shipment-picker.tsx',
  'components/staging/staging-queue.tsx',
  'hooks/use-staging.ts',
  'app/api/staging-items/route.ts',
  'app/api/staging-items/[id]/route.ts',
  'app/api/staging-items/[id]/count/route.ts',
  'app/api/staging-items/[id]/discard/route.ts',
  'app/api/staging-items/[id]/graduate/route.ts',
  'lib/validation/staging.ts',
  'lib/shipments/lifecycle.ts',
];

/** C6.2 — the suites that die with them, whole files. */
const DELETED_SUITES = [
  '__tests__/components/receiving/freight-calculator-panel.test.tsx',
  '__tests__/components/staging/create-staging-dialog.test.tsx',
  '__tests__/components/staging/graduate-dialog.test.tsx',
  '__tests__/components/staging/staging-queue.test.tsx',
  '__tests__/integration/api/inbound-shipment-costs.test.ts',
  '__tests__/integration/api/shipment-link.test.ts',
  '__tests__/integration/api/staging-count-exceptions.test.ts',
  '__tests__/integration/api/staging-count.test.ts',
  '__tests__/integration/api/staging-deadlock-retry.test.ts',
  '__tests__/integration/api/staging-graduate-exceptions.test.ts',
  '__tests__/integration/api/staging-graduate.test.ts',
  '__tests__/integration/api/staging-items-password-hash.test.ts',
  '__tests__/integration/api/staging-items.test.ts',
  '__tests__/integration/api/staging-patch-cost-lock-order.test.ts',
  '__tests__/integration/api/staging-patch-guard.test.ts',
  '__tests__/unit/lib/shipments/cost-allocation.test.ts',
  '__tests__/unit/lib/shipments/lifecycle.test.ts',
  '__tests__/unit/lib/staging/graduate.test.ts',
  '__tests__/unit/lib/validation/inbound-shipment.test.ts',
  '__tests__/unit/lib/validation/staging.test.ts',
];

/** SURVIVES (C6.1): the legacy detail mapper's assert helper and its suite. */
const SURVIVORS = [
  'lib/staging/legacy-line.ts',
  '__tests__/unit/lib/staging/legacy-line.test.ts',
  'lib/shipments/queries.ts',
  'hooks/use-inbound-shipments.ts',
];

/** Trees a reaching import could live in. */
const SCANNED_DIRS = [
  'app',
  'components',
  'hooks',
  'lib',
  '__tests__',
  'concurrency-gate',
  'launch-gate',
  'scripts',
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/** This file names every deleted module in prose; it cannot gate itself. */
const GATE_FILE = '__tests__/unit/lib/overhaul-deletion-gate.test.ts';

/** Module paths (extension-less) no survivor may resolve to. */
const FORBIDDEN_MODULES = new Set(
  [...DELETED_PRODUCTION, ...DELETED_SUITES].map((p) => p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '')),
);

/** Live wire surfaces that died with the routes (C6.3). */
const FORBIDDEN_STRINGS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\/api\/staging-items/, what: 'the retired /api/staging-items route family' },
  {
    pattern: /\/api\/inbound-shipments\/[^\s'"`]*\/costs/,
    what: 'the retired freight-allocation costs route',
  },
  { pattern: /\[\s*["']staging-items["']\s*\]/, what: 'the retired ["staging-items"] query key' },
];

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

/**
 * Blank out comments, preserving offsets and every string literal.
 *
 * A line-comment regex is not good enough here: `'http://t/api/staging-items/5'`
 * is a string with a `//` inside it, and truncating at that `//` would hide the
 * very URL this gate exists to forbid. So the scan walks the text once, tracking
 * whether it is inside a string, a template literal or a comment.
 */
function stripComments(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Every module specifier a file reaches for, however it spells the reach. */
function moduleSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\s+["'`]([^"'`]+)["'`]/g,
    /\brequire(?:\.resolve)?\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bjest\s*\.\s*(?:mock|unmock|doMock|requireActual|requireMock)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** Resolve a specifier to a repo-relative, extension-less module path. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let repoPath: string;
  if (spec.startsWith('@/')) {
    repoPath = spec.slice(2);
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  } else {
    return null; // a package, not one of ours
  }
  return repoPath.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '').replace(/\/index$/, '');
}

interface SourceFile {
  path: string;
  code: string;
}

let sources: SourceFile[];

beforeAll(() => {
  sources = SCANNED_DIRS.flatMap((dir) =>
    walk(path.join(REPO_ROOT, dir))
      .map(toRepoPath)
      .filter((p) => p !== GATE_FILE)
      .map((p) => ({
        path: p,
        code: stripComments(fs.readFileSync(path.join(REPO_ROOT, p), 'utf8')),
      })),
  );
});

describe('overhaul deletion gate — CHECK 1: the retired files are gone', () => {
  it('sweeps a sane source surface (guards against discovery rot)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(300);
    expect(DELETED_PRODUCTION).toHaveLength(19);
    expect(DELETED_SUITES).toHaveLength(20);
  });

  it('every C6.1 production module is absent', () => {
    const survivors = DELETED_PRODUCTION.filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
    expect(
      survivors.length === 0
        ? ''
        : 'Retired production modules still on disk (pack C6.1 — D8 LITERAL):\n' +
            survivors.map((p) => `  ${p}`).join('\n'),
    ).toBe('');
  });

  it('every C6.2 suite is absent', () => {
    const survivors = DELETED_SUITES.filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
    expect(
      survivors.length === 0
        ? ''
        : 'Retired suites still on disk (pack C6.2):\n' + survivors.map((p) => `  ${p}`).join('\n'),
    ).toBe('');
  });

  it('the SURVIVORS really did survive (the gate is not "delete everything")', () => {
    for (const survivor of SURVIVORS) {
      expect(fs.existsSync(path.join(REPO_ROOT, survivor))).toBe(true);
    }
  });
});

describe('overhaul deletion gate — CHECK 2: nothing reaches a retired module', () => {
  it('no static import, dynamic import, require or jest.mock resolves to one', () => {
    const offenders: string[] = [];
    for (const source of sources) {
      for (const spec of moduleSpecifiers(source.code)) {
        const resolved = resolveSpecifier(source.path, spec);
        if (resolved && FORBIDDEN_MODULES.has(resolved)) {
          offenders.push(`  ${source.path} -> ${spec}`);
        }
      }
    }
    expect(
      offenders.length === 0
        ? ''
        : 'Live references to modules M6 deleted. The pre-staging flow and the freight\n' +
            'calculator are retired (pack C6.1/C6.2) — the supply-order surface replaces them:\n' +
            offenders.join('\n'),
    ).toBe('');
  });

  it('no live URL or query key names a retired route', () => {
    const offenders: string[] = [];
    for (const source of sources) {
      for (const { pattern, what } of FORBIDDEN_STRINGS) {
        if (pattern.test(source.code)) offenders.push(`  ${source.path} — ${what}`);
      }
    }
    expect(
      offenders.length === 0
        ? ''
        : 'Live wire references to retired routes (pack C6.3). Comments are exempt; these\n' +
            'are not:\n' +
            offenders.join('\n'),
    ).toBe('');
  });

  it('the comment stripper is not vacuous, and does not eat string literals', () => {
    const stripped = stripComments(
      ['// import x from "@/lib/staging/graduate";', 'const u = "http://t/api/keep-me";'].join('\n'),
    );
    expect(stripped).not.toContain('lib/staging/graduate');
    expect(stripped).toContain('http://t/api/keep-me');
  });

  it('the specifier scan is not vacuous — it finds a reach it is meant to find', () => {
    const code = [
      'import { a } from "@/lib/staging/graduate";',
      'jest.mock("../../lib/validation/staging");',
      'const m = await import("@/hooks/use-staging");',
    ].join('\n');
    const resolved = moduleSpecifiers(code)
      .map((spec) => resolveSpecifier('__tests__/integration/probe.test.ts', spec))
      .filter((r): r is string => r !== null);
    expect(resolved.filter((r) => FORBIDDEN_MODULES.has(r)).sort()).toEqual([
      'hooks/use-staging',
      'lib/staging/graduate',
      'lib/validation/staging',
    ]);
  });
});
