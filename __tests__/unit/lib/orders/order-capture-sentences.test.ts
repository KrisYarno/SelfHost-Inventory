/**
 * @jest-environment node
 *
 * THE ORDER CAPTURE'S LEAF SENTENCES (reconciliation Part 2, pack § P2-B3-1R,
 * R-a.3).
 *
 * The adjust dialog recognises two of the server's sentences by their exact
 * text: the picked-order refusal (`resolve-selected-order.ts`) and the order
 * search's no-company note (`reconciliation/attribution.ts`). Both modules
 * import Prisma, so a client component must never import them as a value — the
 * sentences live in an import-free leaf, the server modules import them FROM
 * the leaf, and the client imports only the leaf.
 *
 * Mostly SOURCE pins, deliberately (the `normalize-order-reference-mirror`
 * idiom): they read the files off disk and load nothing, so no mock can talk
 * them out of their answer. The positive controls prove each pattern bites.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  NO_COMPANY_MEMBERSHIP_NOTE as LEAF_NOTE,
  SELECTED_ORDER_REJECTED_SENTENCE,
} from '@/lib/orders/order-capture-sentences';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LEAF = 'lib/orders/order-capture-sentences.ts';
const SELECTED = 'lib/orders/resolve-selected-order.ts';
const ATTRIBUTION = 'lib/reconciliation/attribution.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Any import, re-export-from or require at all — the leaf is import-free by contract. */
function importsAnything(source: string): boolean {
  return (
    /^\s*import\b/m.test(source) ||
    /^\s*export\s[^;]*\bfrom\s*["']/m.test(source) ||
    /\brequire\s*\(/.test(source)
  );
}

/** A `"use client"` directive as the module's first statement (after comments). */
function isClientModule(source: string): boolean {
  const head = source.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  return /^["']use client["']/.test(head);
}

/**
 * A VALUE import of either server module: any `import … from`, `export … from`,
 * side-effect import, `require` or dynamic `import()` naming it — except a
 * whole-statement `import type` / `export type`, which the compiler erases.
 */
const SERVER_MODULE = String.raw`["'][^"']*(?:\/resolve-selected-order|reconciliation\/attribution)["']`;
const VALUE_IMPORT = new RegExp(
  // One statement only: the span never crosses into the next import/export.
  String.raw`(?:^|\n)\s*(?:import|export)(?!\s+type\b)(?:(?!\n\s*(?:import|export)\b)[^;])*?\bfrom\s*${SERVER_MODULE}` +
    String.raw`|(?:^|\n)\s*import\s*${SERVER_MODULE}` +
    String.raw`|\brequire\s*\(\s*${SERVER_MODULE}` +
    String.raw`|\bimport\s*\(\s*${SERVER_MODULE}`,
);

function walk(rel: string, out: string[]): void {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(child);
  }
}

describe('the leaf holds the sentences, and imports nothing', () => {
  it('imports nothing at all', () => {
    expect(importsAnything(read(LEAF))).toBe(false);
  });

  it("holds the picked-order refusal, byte-for-byte the resolver's sentence", () => {
    expect(SELECTED_ORDER_REJECTED_SENTENCE).toBe(
      'selectedExternalOrderId does not reference an order you can access',
    );
  });

  it('holds the no-company note, and the search module re-exports the SAME value', async () => {
    expect(LEAF_NOTE).toBe(
      'you are not a member of any company yet, so there are no orders to search — ask an admin to add you',
    );
    const attribution = await import('@/lib/reconciliation/attribution');
    expect(attribution.NO_COMPANY_MEMBERSHIP_NOTE).toBe(LEAF_NOTE);
  });
});

describe('the server modules take the sentences FROM the leaf', () => {
  it('resolve-selected-order imports the refusal from the leaf and spells no copy', () => {
    const src = read(SELECTED);
    expect(src).toMatch(
      /import\s*\{[^}]*\bSELECTED_ORDER_REJECTED_SENTENCE\b[^}]*\}\s*from\s*["']@\/lib\/orders\/order-capture-sentences["']/,
    );
    expect(src).not.toContain('does not reference an order you can access');
  });

  it('attribution re-exports the note from the leaf and declares no copy', () => {
    const src = read(ATTRIBUTION);
    expect(src).toMatch(
      /export\s*\{[^}]*\bNO_COMPANY_MEMBERSHIP_NOTE\b[^}]*\}\s*from\s*["']@\/lib\/orders\/order-capture-sentences["']/,
    );
    expect(src).not.toMatch(/\b(const|let|var)\s+NO_COMPANY_MEMBERSHIP_NOTE\b/);
    expect(src).not.toContain('you are not a member of any company yet');
  });
});

describe('no "use client" module imports the server modules as a value', () => {
  const files: string[] = [];
  for (const root of ['app', 'components', 'hooks', 'contexts', 'lib']) walk(root, files);
  const clientFiles = files.filter((f) => isClientModule(read(f)));

  it('scans a real set of client modules (not vacuous)', () => {
    expect(clientFiles.length).toBeGreaterThan(100);
    // The type-only importers of the search module are among them.
    expect(clientFiles).toContain('components/admin/reconciliation/attribution-tab.tsx');
  });

  it('every client module imports resolve-selected-order and reconciliation/attribution as TYPES only, if at all', () => {
    const offenders = clientFiles.filter((f) => VALUE_IMPORT.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the patterns bite (positive and negative controls)', () => {
    for (const src of [
      'import { NO_COMPANY_MEMBERSHIP_NOTE } from "@/lib/reconciliation/attribution";',
      "import { type Viewer, searchOrders } from '@/lib/reconciliation/attribution';",
      'import * as a from "../../lib/reconciliation/attribution";',
      'import "@/lib/reconciliation/attribution";',
      "import { resolveSelectedExternalOrderId } from '@/lib/orders/resolve-selected-order';",
      "export { NO_COMPANY_MEMBERSHIP_NOTE } from '@/lib/reconciliation/attribution';",
      "const m = require('@/lib/orders/resolve-selected-order');",
      "const m = await import('@/lib/reconciliation/attribution');",
    ]) {
      expect(VALUE_IMPORT.test(src)).toBe(true);
    }
    for (const src of [
      'import type { AttributionRow } from "@/lib/reconciliation/attribution";',
      'import type {\n  AttributionRow,\n  BatchDetail,\n} from "@/lib/reconciliation/attribution";',
      'export type { Viewer } from "@/lib/reconciliation/attribution";',
      'import { SELECTED_ORDER_REJECTED_SENTENCE } from "@/lib/orders/order-capture-sentences";',
      'import { ORDER_SEARCH_X } from "@/lib/reconciliation/attribution-keys";',
      // A semicolon-less value import of something else, then a type-only one.
      'import { a } from "b"\nimport type { X } from "@/lib/reconciliation/attribution";',
    ]) {
      expect(VALUE_IMPORT.test(src)).toBe(false);
    }
    expect(isClientModule('"use client";\n\nimport x from "y";')).toBe(true);
    expect(isClientModule('/** doc */\n"use client";\n')).toBe(true);
    expect(isClientModule('import x from "y";\n// "use client"\n')).toBe(false);
    expect(importsAnything('export const A = "x";')).toBe(false);
    expect(importsAnything('import { a } from "b";\nexport const A = a;')).toBe(true);
    expect(importsAnything('export { a } from "b";')).toBe(true);
  });
});
