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
 * SO THIS IS A SOURCE-TEXT PIN, deliberately: it reads both files off disk and
 * compares the normalisation itself — the shape literal, the signature and the
 * body. It imports NEITHER module (one of them pulls Prisma), runs nothing, and
 * therefore cannot be talked out of its answer by a mock. The positive controls
 * at the bottom prove the comparison still bites.
 *
 * When the bar legitimately changes, both copies change in the same commit —
 * which is the whole point of failing here rather than in production.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SOURCE = 'lib/orders/resolve-order-reference.ts';
const MIRROR = 'components/admin/reconciliation/attribute-picker.tsx';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** The regex literal assigned to `ORDER_REFERENCE_SHAPE`, whatever it is. */
function shapeLiteral(source: string): string | null {
  const match = source.match(/ORDER_REFERENCE_SHAPE\s*=\s*(\/.*\/[a-z]*)\s*;/);
  return match === null ? null : match[1];
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

describe('the picker mirrors the server normalisation', () => {
  it('both files still carry the two pieces this pin compares', () => {
    expect(shapeLiteral(sourceText)).not.toBeNull();
    expect(shapeLiteral(mirrorText)).not.toBeNull();
    expect(normalizerText(sourceText)).not.toBeNull();
    expect(normalizerText(mirrorText)).not.toBeNull();
  });

  it('the shape literal is IDENTICAL text', () => {
    expect(shapeLiteral(mirrorText)).toBe(shapeLiteral(sourceText));
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
  it('a widened shape in ONE copy is caught', () => {
    const drifted = mirrorText.replace('/^[0-9]{1,20}$/', '/^[0-9]{1,32}$/');
    expect(drifted).not.toBe(mirrorText);
    expect(shapeLiteral(drifted)).not.toBe(shapeLiteral(sourceText));
  });

  it('a body that stops trimming is caught', () => {
    const drifted = mirrorText.replace('const trimmed = raw.trim();', 'const trimmed = raw;');
    expect(drifted).not.toBe(mirrorText);
    expect(normalizerText(drifted)).not.toBe(normalizerText(sourceText));
  });
});
