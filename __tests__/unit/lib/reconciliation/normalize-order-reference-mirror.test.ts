/**
 * @jest-environment node
 *
 * THE MIRRORED `normalizeOrderReference` (reconciliation lane, M4a dev-5;
 * carried into M4b).
 *
 * The picker pre-seeds its search box with the reference a packer TYPED, and it
 * must apply exactly the bar the server applies — otherwise the surface offers
 * to attribute against text `lib/orders/resolve-order-reference.ts` would never
 * have resolved. That module imports Prisma at module scope, so a client
 * component cannot import it; the picker carries a copy, and a copy nobody
 * checks is a copy that drifts.
 *
 * SO THIS IS A SOURCE-TEXT PIN, deliberately: it reads the files off disk and
 * compares the normalisation itself — the signature and the body. It imports
 * NONE of them (one pulls Prisma), runs nothing, and therefore cannot be talked
 * out of its answer by a mock. The positive controls at the bottom prove the
 * comparison still bites.
 *
 * THE SHAPE IS NO LONGER A COPY (Part 2, pack § P2-B3-1, B3-1b). The regex
 * lives in ONE import-free leaf, `lib/orders/order-reference-shape.ts`, and the
 * resolver, the picker and the adjust dialog each IMPORT it from there. What
 * used to be an equal-copies pin on the literal is now an IMPORT pin: every
 * reader imports the leaf, and none of them declares its own. Since B3-1 FR1
 * the order lookup read the bar too; since § P2-B3-1R (R-b) the ONE order number
 * field that replaced it does, and the old shared hint (`ORDER_REFERENCE_HINT`)
 * is GONE — the field states the bar in its own sentence, and nothing imports
 * or copies the old one.
 *
 * When the bar legitimately changes, it changes in the leaf; when the
 * normalisation changes, both copies of the function change in the same commit
 * — which is the whole point of failing here rather than in production.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SOURCE = 'lib/orders/resolve-order-reference.ts';
const MIRROR = 'components/admin/reconciliation/attribute-picker.tsx';
const LEAF = 'lib/orders/order-reference-shape.ts';
const DIALOG = 'components/inventory/quick-adjust-dialog.tsx';
const FIELD = 'components/inventory/order-number-field.tsx';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** The regex literal assigned to `ORDER_REFERENCE_SHAPE`, whatever it is. */
function shapeLiteral(source: string): string | null {
  const match = source.match(/ORDER_REFERENCE_SHAPE\s*=\s*(\/.*\/[a-z]*)\s*;/);
  return match === null ? null : match[1];
}

/** A binding of its own: `const|let|var ORDER_REFERENCE_SHAPE =`, whatever the value. */
function declaresShape(source: string): boolean {
  return /\b(const|let|var)\s+ORDER_REFERENCE_SHAPE\s*=/.test(source);
}

/** `import { …ORDER_REFERENCE_SHAPE… } from "@/lib/orders/order-reference-shape"`. */
function importsShapeFromLeaf(source: string): boolean {
  return /import\s*\{[^}]*\bORDER_REFERENCE_SHAPE\b[^}]*\}\s*from\s*["']@\/lib\/orders\/order-reference-shape["']/.test(
    source,
  );
}

/** `import { …ORDER_REFERENCE_HINT… } from "@/lib/orders/order-reference-shape"`. */
function importsHintFromLeaf(source: string): boolean {
  return /import\s*\{[^}]*\bORDER_REFERENCE_HINT\b[^}]*\}\s*from\s*["']@\/lib\/orders\/order-reference-shape["']/.test(
    source,
  );
}

/** Any import or require at all — the leaf is import-free by contract. */
function importsAnything(source: string): boolean {
  return /^\s*import\b/m.test(source) || /\brequire\s*\(/.test(source);
}

/**
 * The function, from its signature to the closing brace in column 0 — every
 * line trimmed of trailing whitespace so a stray space cannot fail a pin about
 * behaviour. `export` is stripped: the mirror is module-local by necessity, and
 * that difference is not drift.
 */
function normalizerText(source: string): string | null {
  const start = source.indexOf('function normalizeOrderReference');
  if (start < 0) return null;
  const end = source.indexOf('\n}', start);
  if (end < 0) return null;
  return source
    .slice(start, end + 2)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

const sourceText = read(SOURCE);
const mirrorText = read(MIRROR);
const leafText = read(LEAF);
const dialogText = read(DIALOG);
const fieldText = read(FIELD);

/** Every reader of the bar, by path. */
const IMPORTERS: Array<[string, string]> = [
  [SOURCE, sourceText],
  [MIRROR, mirrorText],
  [DIALOG, dialogText],
  [FIELD, fieldText],
];

describe('the picker mirrors the server normalisation', () => {
  it('the files still carry the pieces this pin compares', () => {
    expect(shapeLiteral(leafText)).not.toBeNull();
    expect(normalizerText(sourceText)).not.toBeNull();
    expect(normalizerText(mirrorText)).not.toBeNull();
  });

  it('the shape has ONE home: the leaf declares it and imports nothing', () => {
    expect(declaresShape(leafText)).toBe(true);
    expect(shapeLiteral(leafText)).toBe('/^[0-9]{1,20}$/');
    expect(importsAnything(leafText)).toBe(false);
  });

  it.each(IMPORTERS)('%s IMPORTS the shape from the leaf and declares no copy', (_path, text) => {
    expect(importsShapeFromLeaf(text)).toBe(true);
    expect(declaresShape(text)).toBe(false);
    expect(shapeLiteral(text)).toBeNull();
  });

  it('the old hint is GONE (§ P2-B3-1R R-b.3): the leaf no longer declares it; no reader imports it or copies its text', () => {
    expect(leafText).not.toContain('ORDER_REFERENCE_HINT');
    expect(leafText).not.toContain('digits only, without #');
    for (const [, text] of IMPORTERS) {
      expect(importsHintFromLeaf(text)).toBe(false);
      expect(text).not.toContain('ORDER_REFERENCE_HINT');
      expect(text).not.toContain('digits only, without #');
    }
  });

  it('the field states the bar in its own sentence, and the dialog blocks on it in its own', () => {
    expect(fieldText).toContain('Order numbers are 1–20 digits.');
    expect(dialogText).toContain('Order number: digits only — fix it or clear it.');
  });

  it('the normalisation lines are IDENTICAL text — signature and body', () => {
    expect(normalizerText(mirrorText)).toBe(normalizerText(sourceText));
  });

  it('the mirror says where it came from, so the next reader finds the original', () => {
    expect(mirrorText).toContain('lib/orders/resolve-order-reference.ts');
  });
});

// ---------------------------------------------------------------------------
// Positive controls — a pin that cannot fail is not a pin
// ---------------------------------------------------------------------------

describe('the comparison bites', () => {
  const LEAF_IMPORT = 'import { ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";';

  it('the import line this control rewrites is really there', () => {
    expect(mirrorText).toContain(LEAF_IMPORT);
  });

  it('the import swapped back for a local (widened) copy is caught', () => {
    const drifted = mirrorText.replace(LEAF_IMPORT, 'const ORDER_REFERENCE_SHAPE = /^[0-9]{1,32}$/;');
    expect(drifted).not.toBe(mirrorText);
    expect(importsShapeFromLeaf(drifted)).toBe(false);
    expect(declaresShape(drifted)).toBe(true);
    expect(shapeLiteral(drifted)).toBe('/^[0-9]{1,32}$/');
  });

  it('a local copy declared BESIDE the import is caught', () => {
    const drifted = `${mirrorText}\nconst ORDER_REFERENCE_SHAPE = /^[0-9]{1,20}$/;\n`;
    expect(importsShapeFromLeaf(drifted)).toBe(true);
    expect(declaresShape(drifted)).toBe(true);
  });

  it('an import from anywhere but the leaf is caught', () => {
    const drifted = mirrorText.replace(
      LEAF_IMPORT,
      'import { ORDER_REFERENCE_SHAPE } from "@/lib/orders/resolve-order-reference";',
    );
    expect(drifted).not.toBe(mirrorText);
    expect(importsShapeFromLeaf(drifted)).toBe(false);
  });

  it('a reader that imports the old hint again is caught', () => {
    const drifted = dialogText.replace(
      'import { ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";',
      'import { ORDER_REFERENCE_HINT, ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";',
    );
    expect(drifted).not.toBe(dialogText);
    expect(importsHintFromLeaf(drifted)).toBe(true);
  });

  it('a leaf that gains an import is caught', () => {
    expect(importsAnything(`import prisma from "@/lib/prisma";\n${leafText}`)).toBe(true);
  });

  it('a body that stops trimming is caught', () => {
    const drifted = mirrorText.replace('const trimmed = raw.trim();', 'const trimmed = raw;');
    expect(drifted).not.toBe(mirrorText);
    expect(normalizerText(drifted)).not.toBe(normalizerText(sourceText));
  });
});
