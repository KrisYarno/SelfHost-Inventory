// @jest-environment node
//
// Reconciliation lane Part 2, A1 (spec REV-8 §2.3/§2.4a, pack CA1.1) — THE
// MATCH VOCABULARY.
//
// `match-keys.ts` is the `class-keys.ts` idiom repeated for the matcher: a
// module with NO imports at all, so the admin chips and (from P2-C) the
// assistant tool can value-import the vocabulary without dragging the Prisma
// singleton into a client chunk. Four things are pinned here:
//
//   * the key arrays exactly — a class the UI cannot name is a class nobody
//     can act on, and a silent addition would go unlabelled;
//   * `matcherUnit`, the RAW-STRING unit admission (spec §2.4a): five units,
//     no alias table, because `normalizeText` strips the micro sign and folds
//     `pack` into `ct` — either would balance masses that are not equal;
//   * `familyKey` PARITY with `lib/matching/normalize.ts` `normalizeText`. The
//     body is inlined so this module stays import-free (pack deviation 2), and
//     an inlined copy that drifts is exactly what the classifyMassUpdateBatch
//     port taught this lane to pin;
//   * the definitions/labels/copy, which ride with every class (truthful data)
//     and are the ONE home for the words the UI prints (seam S-A11).
import fs from 'node:fs';
import path from 'node:path';

import { normalizeText } from '@/lib/matching/normalize';
import {
  FLAGGED_MATCH_CLASSES,
  MATCHER_UNITS,
  MATCH_CLASS_KEYS,
  MATCH_CLASS_LABELS,
  MATCH_DEFINITIONS,
  MATCH_KINDS,
  MATCH_UNAVAILABLE_COPY,
  MATCH_UNAVAILABLE_REASONS,
  UNMATCHABLE,
  familyKey,
  matcherUnit,
} from '@/lib/reconciliation/match-keys';

describe('the closed key vocabularies', () => {
  it('MATCH_CLASS_KEYS is exactly the ten classes, in order', () => {
    expect([...MATCH_CLASS_KEYS]).toEqual([
      'exact',
      'substitution-equivalent',
      'substitution-declared',
      'missing-product',
      'short',
      'over',
      'extra-product',
      'substitution',
      'correction-overrun',
      'mixed',
    ]);
  });

  it('MATCH_KINDS is exactly the five kinds, in the order results render them', () => {
    expect([...MATCH_KINDS]).toEqual(['missing', 'short', 'over', 'extra', 'overrun']);
  });

  it('MATCH_UNAVAILABLE_REASONS is exactly the five producer reasons', () => {
    expect([...MATCH_UNAVAILABLE_REASONS]).toEqual([
      'unstamped',
      'mixed-stamps',
      'order-missing',
      'order-redacted',
      // The fifth (pack REV-7): the matcher refused this order's line data, so
      // the row is listed WITHOUT a match rather than taking the whole page down.
      'match-error',
    ]);
  });

  it('UNMATCHABLE is the matcher own reason and is NOT a producer reason', () => {
    expect(UNMATCHABLE).toBe('unmatchable');
    expect([...MATCH_UNAVAILABLE_REASONS]).not.toContain(UNMATCHABLE);
  });

  it('FLAGGED_MATCH_CLASSES is exactly the seven an admin should look at', () => {
    expect(Array.from(FLAGGED_MATCH_CLASSES).sort()).toEqual([
      'correction-overrun',
      'extra-product',
      'missing-product',
      'mixed',
      'over',
      'short',
      'substitution',
    ]);
  });

  it('the three tolerated classes are NOT flagged', () => {
    for (const k of ['exact', 'substitution-equivalent', 'substitution-declared'] as const) {
      expect(FLAGGED_MATCH_CLASSES.has(k)).toBe(false);
    }
  });

  it('every flagged class is a real class key', () => {
    for (const k of Array.from(FLAGGED_MATCH_CLASSES)) {
      expect(MATCH_CLASS_KEYS).toContain(k);
    }
  });
});

describe('matcherUnit — raw-string admission (spec §2.4a: no alias table)', () => {
  it('MATCHER_UNITS is exactly the five admitted units', () => {
    expect([...MATCHER_UNITS]).toEqual(['mg', 'mcg', 'ml', 'iu', 'g']);
  });

  it.each([
    ['mg', 'mg'],
    [' MG ', 'mg'],
    ['mL', 'ml'],
    ['ml', 'ml'],
    ['MCG', 'mcg'],
    ['  iu', 'iu'],
    ['G', 'g'],
    ['m  g', null],
  ])('admits %p as %p', (raw, expected) => {
    expect(matcherUnit(raw)).toBe(expected);
  });

  it.each(['µg', 'ug', 'pack', 'ct', 'l', 'kg', 'each', ''])('refuses %p', (raw) => {
    expect(matcherUnit(raw)).toBeNull();
  });

  it('refuses null and undefined (a product with no unit is undecomposable)', () => {
    expect(matcherUnit(null)).toBeNull();
    expect(matcherUnit(undefined)).toBeNull();
  });

  it('trims and folds whitespace before matching — the fold COLLAPSES runs, it does not delete them', () => {
    expect(matcherUnit('\tmg\n')).toBe('mg');
    expect(matcherUnit('  m  l  ')).toBeNull();
  });
});

describe('familyKey — a verbatim inline of normalizeText (parity, pack deviation 2)', () => {
  const FIXTURES = [
    'Semaglutide (10mg)',
    'BPC-157',
    '  Tirzepatide  ',
    'Semaglutide',
    'semaglutide',
    'SEMAGLUTIDE',
    'Retatrutide / blend',
    'NAD+',
    'GLOW (GHK-Cu µ blend)',
    'µg dosed peptide',
    'A   B',
    '123 456',
    'Product   Name --- 2',
    '   ',
    '',
  ];

  it.each(FIXTURES)('matches normalizeText on %p', (raw) => {
    expect(familyKey(raw)).toBe(normalizeText(raw));
  });

  it('a whitespace-only baseName is the empty key (the matcher treats it as undecomposable)', () => {
    expect(familyKey('   ')).toBe('');
  });

  it('strips punctuation and folds case and whitespace', () => {
    expect(familyKey('Semaglutide (10mg)')).toBe('semaglutide 10mg');
    expect(familyKey('BPC-157')).toBe('bpc 157');
    expect(familyKey('  Tirzepatide  ')).toBe('tirzepatide');
  });

  it('drops the micro sign exactly as normalizeText does (why the UNIT rule is raw)', () => {
    expect(familyKey('µg')).toBe(normalizeText('µg'));
    expect(familyKey('µg')).toBe('g');
  });
});

describe('the words that ride with every class (truthful data + seam S-A11)', () => {
  it('MATCH_DEFINITIONS keys are exactly the classes, the reasons, unmatchable, grain and tolerance', () => {
    expect(Object.keys(MATCH_DEFINITIONS).sort()).toEqual(
      [
        ...MATCH_CLASS_KEYS,
        ...MATCH_UNAVAILABLE_REASONS,
        UNMATCHABLE,
        'grain',
        'tolerance',
      ].sort(),
    );
  });

  it('every definition is a non-empty sentence', () => {
    for (const [key, text] of Object.entries(MATCH_DEFINITIONS)) {
      expect(typeof text).toBe('string');
      expect(text.trim().length).toBeGreaterThan(0);
      expect(`${key}: ${text}`).not.toContain('undefined');
    }
  });

  it('MATCH_CLASS_LABELS is exactly one label per class, verbatim', () => {
    expect(Object.keys(MATCH_CLASS_LABELS).sort()).toEqual([...MATCH_CLASS_KEYS].sort());
    expect({ ...MATCH_CLASS_LABELS }).toEqual({
      exact: 'Exact',
      'substitution-equivalent': 'Swap — mg-equivalent',
      'substitution-declared': 'Swap — declared',
      'missing-product': 'Missing product',
      short: 'Short',
      over: 'Over',
      'extra-product': 'Extra product',
      substitution: 'Substitution',
      'correction-overrun': 'Correction overrun',
      mixed: 'Mixed',
    });
  });

  it('MATCH_UNAVAILABLE_COPY is exactly one phrase per reason, verbatim', () => {
    expect(Object.keys(MATCH_UNAVAILABLE_COPY).sort()).toEqual([
      ...MATCH_UNAVAILABLE_REASONS,
    ].sort());
    expect({ ...MATCH_UNAVAILABLE_COPY }).toEqual({
      unstamped: 'no order to compare',
      'mixed-stamps': 'mixed stamps',
      'order-missing': 'order missing',
      'order-redacted': "another company's order",
      'match-error': 'could not be matched (bad line data)',
    });
  });

  it('every label and every copy phrase is non-empty', () => {
    for (const v of [...Object.values(MATCH_CLASS_LABELS), ...Object.values(MATCH_UNAVAILABLE_COPY)]) {
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the module is IMPORT-FREE (the class-keys.ts idiom)', () => {
  it('carries no import statement at all', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../../lib/reconciliation/match-keys.ts'),
      'utf8',
    );
    expect(/^\s*import\b/m.test(src)).toBe(false);
    expect(src).not.toContain('require(');
  });
});
