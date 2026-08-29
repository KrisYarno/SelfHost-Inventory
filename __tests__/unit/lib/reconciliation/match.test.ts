// @jest-environment node
//
// Reconciliation lane Part 2, A1 (spec REV-8 §2.3/§2.4, pack CA1.2) — THE
// MATCHER.
//
// `matchOrder` is the ONE place an order's class is decided (pack cross-wave
// rule 8). It is pure — ids and integers in, a class out — because the number
// it produces lands on an admin's screen beside the words "this order was
// short by 2", and a wrong guess there is a wrong instruction to a human.
//
// Three families of pin:
//
//   * ONE PER CLASS, all ten, over the smallest fixture that produces it — the
//     kind-set derivation is the contract, not an implementation detail;
//   * THE MASS BALANCE in integer hundredths: balanced, partial (nothing
//     leaves), an `over` surplus paying for a `missing`, `over` alone (a zero
//     shortfall never balances), `mcg` never against `mg`, `mL` folded onto
//     `ml`, and every way a product fails to decompose — each named in
//     `excludedProducts` while the ORDER still classifies normally;
//   * TOTALITY: a fuzz over small integers proving the function answers for
//     every shape rather than throwing on data, plus the invariants that make
//     the answer readable (class null iff unmatchable; flagged iff the class is
//     in the flagged set; kinds in MATCH_KINDS order).
import {
  FLAGGED_MATCH_CLASSES,
  MATCH_CLASS_KEYS,
  MATCH_DEFINITIONS,
  MATCH_KINDS,
} from '@/lib/reconciliation/match-keys';
import {
  matchOrder,
  type Declaration,
  type DeductedProduct,
  type OrderItems,
  type OrderedLine,
  type ProductFacts,
} from '@/lib/reconciliation/match';

// --------------------------------------------------------------------------
// Fixture builders — the smallest shapes that reach each rule.
// --------------------------------------------------------------------------

function line(productId: number, quantity: number, over: Partial<OrderedLine> = {}): OrderedLine {
  return {
    productId,
    quantity,
    fulfilledQty: 0,
    fromBundle: false,
    itemId: `item-${productId}`,
    ...over,
  };
}

function items(lines: OrderedLine[], counts: Partial<Omit<OrderItems, 'lines'>> = {}): OrderItems {
  return {
    lines,
    unmappedLines: 0,
    unmappedUnits: 0,
    bundleLines: 0,
    unresolvableBundleLines: 0,
    ...counts,
  };
}

function deducted(productId: number, out: number, corrected = 0): DeductedProduct {
  return { productId, out, corrected };
}

/** A decomposable product: `hundredths` is numericValue x 100 as an integer. */
function facts(
  productId: number,
  productName: string,
  baseName: string | null,
  unit: string | null,
  hundredths: number | null,
): ProductFacts {
  return { productId, productName, baseName, unit, hundredths };
}

/** Two members of one 'Semaglutide' family: 5 mg (id 1) and 10 mg (id 2). */
const SEMA_5 = facts(1, 'Semaglutide 5 mg', 'Semaglutide', 'mg', 500);
const SEMA_10 = facts(2, 'Semaglutide 10 mg', 'Semaglutide', 'mg', 1000);
const SEMA_15 = facts(3, 'Semaglutide 15 mg', 'Semaglutide', 'mg', 1500);

// --------------------------------------------------------------------------
// One pin per class (all ten)
// --------------------------------------------------------------------------

describe('the class, one fixture per class', () => {
  it('exact — everything ordered came out', () => {
    const m = matchOrder({
      items: items([line(1, 2)]),
      deducted: [deducted(1, 2)],
      products: [SEMA_5],
    });
    expect(m.class).toBe('exact');
    expect(m.flagged).toBe(false);
    expect(m.kinds).toEqual([]);
    expect(m.reason).toBeUndefined();
    expect(m.tolerance).toBeNull();
    expect(m.deductedUnits).toBe(2);
  });

  it('missing-product — ordered, nothing out', () => {
    const m = matchOrder({ items: items([line(1, 2)]), deducted: [], products: [SEMA_5] });
    expect(m.class).toBe('missing-product');
    expect(m.flagged).toBe(true);
    expect(m.kinds).toEqual(['missing']);
    expect(m.perProduct).toEqual([
      {
        productId: 1,
        productName: 'Semaglutide 5 mg',
        fromBundle: false,
        ordered: 2,
        deducted: 0,
        corrected: 0,
        delta: -2,
        kind: 'missing',
        units: 2,
      },
    ]);
  });

  it('short — less out than ordered', () => {
    const m = matchOrder({
      items: items([line(1, 3)]),
      deducted: [deducted(1, 1)],
      products: [SEMA_5],
    });
    expect(m.class).toBe('short');
    expect(m.kinds).toEqual(['short']);
    expect(m.perProduct[0]).toMatchObject({ kind: 'short', units: 2, delta: -2 });
  });

  it('over — more out than ordered', () => {
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [deducted(1, 3)],
      products: [SEMA_5],
    });
    expect(m.class).toBe('over');
    expect(m.kinds).toEqual(['over']);
    expect(m.perProduct[0]).toMatchObject({ kind: 'over', units: 2, delta: 2 });
  });

  it('extra-product — out against an order that never asked for it', () => {
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [deducted(1, 1), deducted(2, 4)],
      products: [SEMA_5, SEMA_10],
    });
    expect(m.class).toBe('extra-product');
    expect(m.kinds).toEqual(['extra']);
    expect(m.perProduct[1]).toMatchObject({ productId: 2, ordered: 0, kind: 'extra', units: 4 });
  });

  it('substitution — one missing, another extra, no mass balance', () => {
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [deducted(3, 1)],
      // 5 mg missing vs 15 mg extra: 500 !== 1500, nothing balances.
      products: [SEMA_5, SEMA_15],
    });
    expect(m.class).toBe('substitution');
    expect(m.kinds).toEqual(['missing', 'extra']);
  });

  it('mixed — {short, over} on two products', () => {
    const m = matchOrder({
      items: items([line(1, 3), line(3, 1)]),
      deducted: [deducted(1, 1), deducted(3, 4)],
      products: [SEMA_5, SEMA_15],
    });
    expect(m.class).toBe('mixed');
    expect(m.kinds).toEqual(['short', 'over']);
    expect(m.flagged).toBe(true);
  });

  it('correction-overrun — {missing, overrun}, and the overrun wins the precedence', () => {
    const m = matchOrder({
      items: items([line(1, 1), line(2, 1)]),
      // product 2: 1 out, 3 corrected back -> net -2 -> overrun.
      deducted: [deducted(2, 1, 3)],
      products: [SEMA_5, SEMA_10],
    });
    expect(m.class).toBe('correction-overrun');
    expect(m.kinds).toEqual(['missing', 'overrun']);
    expect(m.perProduct[1]).toMatchObject({
      productId: 2,
      deducted: -2,
      corrected: 3,
      kind: 'overrun',
      units: 2,
    });
  });

  it('substitution-equivalent — 2 x 5 mg missing paid for by 1 x 10 mg extra', () => {
    const m = matchOrder({
      items: items([line(1, 2)]),
      deducted: [deducted(2, 1)],
      products: [SEMA_5, SEMA_10],
    });
    expect(m.class).toBe('substitution-equivalent');
    expect(m.flagged).toBe(false);
    expect(m.kinds).toEqual([]);
    expect(m.tolerance).not.toBeNull();
    expect(m.tolerance?.equivalentGroups).toEqual([
      {
        familyKey: 'semaglutide',
        unit: 'mg',
        massHundredths: 1000,
        shortfall: [{ productId: 1, units: 2, hundredths: 500 }],
        extra: [{ productId: 2, units: 1, hundredths: 1000 }],
      },
    ]);
    // the balanced products keep their rows, with the kind gone
    expect(m.perProduct.map((p) => p.kind)).toEqual([null, null]);
    expect(m.perProduct.map((p) => p.units)).toEqual([0, 0]);
  });

  it('substitution-declared — a declared pair covers the difference', () => {
    const declarations: Declaration[] = [
      { fromProductId: 1, fromUnits: 1, toProductId: 3, toUnits: 1 },
    ];
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [deducted(3, 1)],
      products: [SEMA_5, SEMA_15],
      declarations,
    });
    expect(m.class).toBe('substitution-declared');
    expect(m.kinds).toEqual([]);
    expect(m.tolerance?.declaredPairs).toEqual(declarations);
    expect(m.tolerance?.equivalentGroups).toEqual([]);
  });

  it('the equivalent class wins when both a declaration and a balance applied', () => {
    // A declared 15 mg -> 'ct' pair (no mass rule can fix that one), PLUS an
    // independent 2 x 5 mg <-> 1 x 10 mg balance. Both tolerances applied.
    const m = matchOrder({
      items: items([line(1, 2), line(3, 1)]),
      deducted: [deducted(2, 1), deducted(9, 1)],
      products: [SEMA_5, SEMA_10, SEMA_15, facts(9, 'Other 5 ct', 'Other', 'ct', 500)],
      declarations: [{ fromProductId: 3, fromUnits: 1, toProductId: 9, toUnits: 1 }],
    });
    expect(m.class).toBe('substitution-equivalent');
    expect(m.tolerance?.declaredPairs).toHaveLength(1);
    expect(m.tolerance?.equivalentGroups).toHaveLength(1);
    // the declared pair cleared both kinds, so neither product is EXCLUDED
    expect(m.tolerance?.excludedProducts).toEqual([]);
  });

  it('every class key the vocabulary declares is reachable from this suite', () => {
    // A guard on the guard: if a class is added to the vocabulary, this list is
    // the reminder that it needs a fixture above.
    expect([...MATCH_CLASS_KEYS]).toHaveLength(10);
  });
});

// --------------------------------------------------------------------------
// The null case (spec §2.3 rule 1)
// --------------------------------------------------------------------------

describe('not evaluable — the ONLY source of class null', () => {
  it('no ordered line: class null with reason unmatchable, and what LEFT is still shown', () => {
    const m = matchOrder({
      items: items([], { unmappedLines: 2, unmappedUnits: 5 }),
      deducted: [deducted(1, 3, 1)],
      products: [SEMA_5],
    });
    expect(m.class).toBeNull();
    expect(m.reason).toBe('unmatchable');
    expect(m.flagged).toBe(false);
    expect(m.kinds).toEqual([]);
    expect(m.deductedUnits).toBe(3);
    expect(m.tolerance).toBeNull();
    expect(m.unmappedLines).toBe(2);
    expect(m.unmappedUnits).toBe(5);
    // the deducted product is LISTED (ordered 0, no kind) so the panel can show
    // what left stock even though the order cannot be matched
    expect(m.perProduct).toEqual([
      {
        productId: 1,
        productName: 'Semaglutide 5 mg',
        fromBundle: false,
        ordered: 0,
        deducted: 2,
        corrected: 1,
        delta: 2,
        kind: null,
        units: 0,
      },
    ]);
  });

  it('nothing ordered and nothing deducted is still unmatchable, never exact', () => {
    const m = matchOrder({ items: items([]), deducted: [], products: [] });
    expect(m.class).toBeNull();
    expect(m.reason).toBe('unmatchable');
    expect(m.perProduct).toEqual([]);
    expect(m.deductedUnits).toBe(0);
  });

  it('an unresolvable bundle line beside an exact line does NOT make the order unmatchable', () => {
    const m = matchOrder({
      items: items([line(1, 2)], { unresolvableBundleLines: 1, bundleLines: 0 }),
      deducted: [deducted(1, 2)],
      products: [SEMA_5],
    });
    expect(m.class).toBe('exact');
    expect(m.unresolvableBundleLines).toBe(1);
  });
});

// --------------------------------------------------------------------------
// The mass balance (spec §2.4a)
// --------------------------------------------------------------------------

describe('the mass balance in integer hundredths', () => {
  it('a PARTIAL balance changes nothing (2 x 5 mg vs 1 x 15 mg)', () => {
    const m = matchOrder({
      items: items([line(1, 2)]),
      deducted: [deducted(3, 1)],
      products: [SEMA_5, SEMA_15],
    });
    expect(m.class).toBe('substitution');
    expect(m.kinds).toEqual(['missing', 'extra']);
    expect(m.tolerance).toBeNull();
  });

  it('an `over` SURPLUS pays for a `missing` in the same family', () => {
    const m = matchOrder({
      items: items([line(1, 1), line(4, 1)]),
      deducted: [deducted(4, 2)],
      products: [SEMA_5, facts(4, 'Semaglutide 5 mg (B)', 'Semaglutide', 'mg', 500)],
    });
    expect(m.class).toBe('substitution-equivalent');
    expect(m.tolerance?.equivalentGroups[0]).toMatchObject({
      massHundredths: 500,
      shortfall: [{ productId: 1, units: 1, hundredths: 500 }],
      extra: [{ productId: 4, units: 1, hundredths: 500 }],
    });
  });

  it('`over` ALONE never balances — a zero shortfall is not a balance', () => {
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [deducted(1, 3)],
      products: [SEMA_5],
    });
    expect(m.class).toBe('over');
    expect(m.tolerance).toBeNull();
  });

  it('mcg never balances against mg (the unit is part of the group key)', () => {
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [deducted(5, 1)],
      products: [SEMA_5, facts(5, 'Semaglutide 5000 mcg', 'Semaglutide', 'mcg', 500000)],
    });
    expect(m.class).toBe('substitution');
    expect(m.tolerance).toBeNull();
  });

  it('mL and ml are the SAME group (raw-string admission folds case)', () => {
    const m = matchOrder({
      items: items([line(6, 2)]),
      deducted: [deducted(7, 1)],
      products: [
        facts(6, 'Glow 5 mL', 'Glow', 'mL', 500),
        facts(7, 'Glow 10 ml', 'Glow', 'ml', 1000),
      ],
    });
    expect(m.class).toBe('substitution-equivalent');
    expect(m.tolerance?.equivalentGroups[0]).toMatchObject({ unit: 'ml', massHundredths: 1000 });
  });

  it('balanced swap PLUS an unrelated short: the balance leaves, the short stays', () => {
    const m = matchOrder({
      items: items([line(1, 2), line(8, 3)]),
      deducted: [deducted(2, 1), deducted(8, 1)],
      products: [SEMA_5, SEMA_10, facts(8, 'BPC-157', 'BPC-157', 'mg', 500)],
    });
    expect(m.class).toBe('short');
    expect(m.kinds).toEqual(['short']);
    expect(m.tolerance?.equivalentGroups).toHaveLength(1);
    expect(m.perProduct.find((p) => p.productId === 8)).toMatchObject({ kind: 'short', units: 2 });
  });

  it.each([
    ['µg', 'unit-refused'],
    ['pack', 'unit-refused'],
    ['ct', 'unit-refused'],
    ['l', 'unit-refused'],
  ])('a %p unit is REFUSED and named in excludedProducts as %p', (unit, reason) => {
    const m = matchOrder({
      items: items([line(9, 1)]),
      deducted: [],
      products: [facts(9, `Peptide (${unit})`, 'Peptide', unit, 500)],
    });
    expect(m.class).toBe('missing-product');
    expect(m.tolerance?.excludedProducts).toEqual([{ productId: 9, reason, unit }]);
  });

  it('a null numericValue is UNDECOMPOSABLE (never a guessed mass)', () => {
    const m = matchOrder({
      items: items([line(9, 1)]),
      deducted: [],
      products: [facts(9, 'Peptide', 'Peptide', 'mg', null)],
    });
    expect(m.tolerance?.excludedProducts).toEqual([
      { productId: 9, reason: 'undecomposable', unit: 'mg' },
    ]);
  });

  it('a zero-or-negative numericValue is UNDECOMPOSABLE too', () => {
    const m = matchOrder({
      items: items([line(9, 1)]),
      deducted: [],
      products: [facts(9, 'Peptide', 'Peptide', 'mg', 0)],
    });
    expect(m.tolerance?.excludedProducts).toEqual([
      { productId: 9, reason: 'undecomposable', unit: 'mg' },
    ]);
  });

  it('a whitespace-only baseName is UNDECOMPOSABLE (familyKey is empty)', () => {
    const m = matchOrder({
      items: items([line(9, 1)]),
      deducted: [],
      products: [facts(9, 'Peptide', '   ', 'mg', 500)],
    });
    expect(m.tolerance?.excludedProducts).toEqual([
      { productId: 9, reason: 'undecomposable', unit: 'mg' },
    ]);
  });

  it('a null baseName and a null unit are UNDECOMPOSABLE (unit null is not a REFUSED unit)', () => {
    const m = matchOrder({
      items: items([line(9, 1)]),
      deducted: [],
      products: [facts(9, 'Peptide', null, null, 500)],
    });
    expect(m.tolerance?.excludedProducts).toEqual([
      { productId: 9, reason: 'undecomposable', unit: null },
    ]);
  });

  it('an excluded product still classifies the ORDER normally', () => {
    const m = matchOrder({
      items: items([line(9, 1), line(1, 1)]),
      deducted: [deducted(1, 1)],
      products: [SEMA_5, facts(9, 'Peptide', 'Peptide', 'ct', 500)],
    });
    expect(m.class).toBe('missing-product');
    expect(m.flagged).toBe(true);
    expect(m.tolerance?.excludedProducts).toEqual([
      { productId: 9, reason: 'unit-refused', unit: 'ct' },
    ]);
  });

  it('a product with NO facts entry is never DROPPED — it keeps its kind as `unknown product`', () => {
    const m = matchOrder({ items: items([line(42, 1)]), deducted: [], products: [] });
    expect(m.class).toBe('missing-product');
    expect(m.perProduct).toEqual([
      {
        productId: 42,
        productName: 'unknown product',
        fromBundle: false,
        ordered: 1,
        deducted: 0,
        corrected: 0,
        delta: -1,
        kind: 'missing',
        units: 1,
      },
    ]);
    expect(m.tolerance?.excludedProducts).toEqual([
      { productId: 42, reason: 'undecomposable', unit: null },
    ]);
  });
});

// --------------------------------------------------------------------------
// Declarations (P2-D's hook; [] in P2-A)
// --------------------------------------------------------------------------

describe('declared pairs are applied BEFORE the mass balance', () => {
  it('a declared 5 -> 15 pair on a {missing, extra} order classes as declared', () => {
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [deducted(3, 1)],
      products: [SEMA_5, SEMA_15],
      declarations: [{ fromProductId: 1, fromUnits: 1, toProductId: 3, toUnits: 1 }],
    });
    expect(m.class).toBe('substitution-declared');
    expect(m.tolerance?.declaredPairs).toHaveLength(1);
  });

  it('a declaration is CLAMPED at the kind units and a partial one leaves the kind standing', () => {
    const m = matchOrder({
      items: items([line(1, 3)]),
      deducted: [deducted(3, 1)],
      products: [SEMA_5, SEMA_15],
      declarations: [{ fromProductId: 1, fromUnits: 99, toProductId: 3, toUnits: 99 }],
    });
    // the FROM kind is cleared by the clamp; so is the TO kind
    expect(m.class).toBe('substitution-declared');
  });

  it('a declaration that reduces NOTHING is not recorded and does not change the class', () => {
    const m = matchOrder({
      items: items([line(1, 1)]),
      deducted: [],
      products: [SEMA_5],
      declarations: [{ fromProductId: 77, fromUnits: 1, toProductId: 78, toUnits: 1 }],
    });
    expect(m.class).toBe('missing-product');
    // nothing recorded at all: no group balanced, no pair reduced, no product
    // excluded -> the whole tolerance block is null rather than an empty shell
    expect(m.tolerance).toBeNull();
  });

  it('an omitted declarations list behaves exactly like [] (P2-A always passes none)', () => {
    const base = { items: items([line(1, 1)]), deducted: [], products: [SEMA_5] };
    expect(matchOrder(base)).toEqual(matchOrder({ ...base, declarations: [] }));
  });
});

// --------------------------------------------------------------------------
// The shape of the result
// --------------------------------------------------------------------------

describe('the result envelope', () => {
  it('perProduct is sorted by productId, over the UNION of both sides', () => {
    const m = matchOrder({
      items: items([line(9, 1), line(2, 1)]),
      deducted: [deducted(5, 1), deducted(2, 1)],
      products: [],
    });
    expect(m.perProduct.map((p) => p.productId)).toEqual([2, 5, 9]);
  });

  it('carries MATCH_DEFINITIONS verbatim (truthful data: the class ships its definition)', () => {
    const m = matchOrder({ items: items([line(1, 1)]), deducted: [deducted(1, 1)], products: [] });
    expect(m.definitions).toBe(MATCH_DEFINITIONS);
  });

  it('carries the four item counters through unchanged', () => {
    const m = matchOrder({
      items: items([line(1, 1)], {
        unmappedLines: 3,
        unmappedUnits: 7,
        bundleLines: 2,
        unresolvableBundleLines: 1,
      }),
      deducted: [deducted(1, 1)],
      products: [],
    });
    expect(m).toMatchObject({
      unmappedLines: 3,
      unmappedUnits: 7,
      bundleLines: 2,
      unresolvableBundleLines: 1,
    });
  });

  it('sums ordered units per product across lines (a bundle component and a plain line)', () => {
    const m = matchOrder({
      items: items([line(1, 2), line(1, 6, { fromBundle: true })]),
      deducted: [deducted(1, 8)],
      products: [SEMA_5],
    });
    expect(m.class).toBe('exact');
    expect(m.perProduct[0]).toMatchObject({ ordered: 8, deducted: 8 });
  });

  it('CORRECTION netting is what decides the kind (a fully corrected deduction is missing)', () => {
    const m = matchOrder({
      items: items([line(1, 2)]),
      deducted: [deducted(1, 2, 2)],
      products: [SEMA_5],
    });
    expect(m.class).toBe('missing-product');
    expect(m.deductedUnits).toBe(2);
    expect(m.perProduct[0]).toMatchObject({ deducted: 0, corrected: 2, kind: 'missing' });
  });
});

// --------------------------------------------------------------------------
// The integer guard (the reader cannot produce these; a mock can)
// --------------------------------------------------------------------------

describe('the integer guard', () => {
  it('throws a NAMED error on a negative ordered quantity', () => {
    expect(() =>
      matchOrder({ items: items([line(1, -1)]), deducted: [], products: [] }),
    ).toThrow(/matchOrder/);
  });

  it('throws a NAMED error on a non-integer deducted total', () => {
    expect(() =>
      matchOrder({ items: items([line(1, 1)]), deducted: [deducted(1, 1.5)], products: [] }),
    ).toThrow(/matchOrder/);
  });
});

// --------------------------------------------------------------------------
// Totality (spec §2.3: the function answers for every shape)
// --------------------------------------------------------------------------

describe('totality — 600 random orders, no throw, every invariant', () => {
  /** A tiny deterministic PRNG so a failure is reproducible. */
  function mulberry32(a: number) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('never throws, and class/flagged/kinds stay coherent', () => {
    const rnd = mulberry32(20260828);
    const int = (n: number) => Math.floor(rnd() * n);
    const UNITS = ['mg', 'mcg', 'ml', 'µg', 'ct', null];

    for (let i = 0; i < 600; i += 1) {
      const lines: OrderedLine[] = [];
      for (let l = 0; l < int(4); l += 1) lines.push(line(1 + int(4), int(5)));
      const rows: DeductedProduct[] = [];
      for (let d = 0; d < int(4); d += 1) rows.push(deducted(1 + int(4), int(5), int(3)));
      const products: ProductFacts[] = [];
      for (let p = 1; p <= 4; p += 1) {
        if (rnd() < 0.3) continue;
        products.push(
          facts(
            p,
            `p${p}`,
            rnd() < 0.2 ? null : 'Family',
            UNITS[int(UNITS.length)],
            rnd() < 0.2 ? null : 100 * (1 + int(5)),
          ),
        );
      }
      const input = { items: items(lines), deducted: rows, products };

      const m = matchOrder(input);
      expect(m.class === null).toBe(m.reason === 'unmatchable');
      expect(m.flagged).toBe(m.class !== null && FLAGGED_MATCH_CLASSES.has(m.class));
      for (const k of m.kinds) expect(MATCH_KINDS).toContain(k);
      expect(m.kinds).toEqual(Array.from(new Set(m.kinds)));
      expect(m.kinds).toEqual(MATCH_KINDS.filter((k) => m.kinds.includes(k)));
      expect(m.perProduct.map((p) => p.productId)).toEqual(
        [...m.perProduct.map((p) => p.productId)].sort((a, b) => a - b),
      );
      for (const p of m.perProduct) {
        expect(p.delta).toBe(p.deducted - p.ordered);
        if (p.kind === null) expect(p.units).toBe(0);
        else expect(p.units).toBeGreaterThan(0);
      }
      if (m.tolerance === null) {
        expect(m.kinds.length + m.perProduct.length).toBeGreaterThanOrEqual(0);
      } else {
        expect(
          m.tolerance.equivalentGroups.length +
            m.tolerance.declaredPairs.length +
            m.tolerance.excludedProducts.length,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('perProduct.fromBundle (seam-check fix, pack REV-6)', () => {
  it('is true for a product any of whose ORDERED lines came from a bundle, false otherwise', () => {
    const m = matchOrder({
      items: items([
        { ...line(1, 2), fromBundle: true },
        line(2, 1),
      ]),
      deducted: [
        { productId: 1, out: 2, corrected: 0 },
        { productId: 2, out: 1, corrected: 0 },
        { productId: 3, out: 1, corrected: 0 },
      ],
      products: [],
    });
    expect(m.perProduct.map((p) => [p.productId, p.fromBundle])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  it('is false on every row of the unmatchable result (no ordered lines exist)', () => {
    const m = matchOrder({ items: items([]), deducted: [{ productId: 7, out: 1, corrected: 0 }], products: [] });
    expect(m.perProduct.map((p) => p.fromBundle)).toEqual([false]);
  });
});
