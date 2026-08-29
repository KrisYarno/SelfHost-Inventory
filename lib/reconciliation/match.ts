/**
 * THE MATCHER (reconciliation lane Part 2, spec REV-8 §2.3/§2.4; pack CA1.2).
 *
 * One order in, one class out. PURE: ids and integers only, no Prisma, no I/O,
 * no clock — the producer does the reading, this module does the deciding, and
 * the class is decided HERE and nowhere else (pack cross-wave rule 8). Two
 * consequences worth stating, because both are load-bearing:
 *
 *   * it is TOTAL on data, bar one refusal. Every input shape returns a result;
 *     the only throw is `MatcherRefusal` from the integer guards below — a
 *     negative or fractional unit count, which a reader CAN hand over (the
 *     item quantity is a plain signed Int) and which the producer catches per
 *     order and renders as `match-error`. An admin surface that says so is
 *     honest; one that 500s on an odd order is not.
 *   * it holds NO names it did not need. `perProduct[].productName` is an
 *     INTERNAL product name (the same fact the ledger rows already ship) and is
 *     the only string on the result that names anything (pack rule 5).
 *
 * The two sides are counted the way spec §2.2 defines them: ordered units per
 * product from the expanded lines, `deducted = out - corrected` per product
 * from the ledger aggregate. A negative net is an overrun — corrections gave
 * back more than ever left — and it is history, not a number to hide.
 *
 * Next-free, Prisma-free and textually write-free (pack cross-wave rule 2):
 * this module is on the assistant's read path.
 */

import {
  FLAGGED_MATCH_CLASSES,
  MATCH_DEFINITIONS,
  MATCH_KINDS,
  UNMATCHABLE,
  familyKey,
  matcherUnit,
  type MatchClassKey,
  type MatchKind,
  type MatcherUnit,
} from './match-keys';

/** One ordered-side line AFTER expansion (bundle components already multiplied). Ids + integers only. */
export type OrderedLine = {
  productId: number;          // never null here — unmapped/unlinked lines never reach the matcher's ordered side
  quantity: number;           // ordered units (component rows: line.quantity x component.quantity)
  fulfilledQty: number;       // the line's fulfilledQty (component rows: x component.quantity) — read by P2-D only
  fromBundle: boolean;
  itemId: string;             // the external_order_items row id (for P2-D's FROM validation); never a name
};

/** What `items.ts` hands over per order. */
export type OrderItems = {
  lines: OrderedLine[];
  unmappedLines: number;      // isMapped === false OR productLink null OR (non-bundle link with internalProductId null)
  unmappedUnits: number;      // sum of quantity over those lines
  bundleLines: number;        // bundle lines that RESOLVED (their components are in `lines`)
  unresolvableBundleLines: number;  // bundle lines whose snapshot/live resolution failed (ok:false) — counted, never fatal
};

/** The deducted side per product, as the aggregate builder returns it (already `toNumber`ed). */
export type DeductedProduct = { productId: number; out: number; corrected: number };

/**
 * Decomposition facts per product id (from `products.baseName/unit/numericValue`).
 * `hundredths` = numericValue x 100 as an INTEGER, or null. A product id on
 * either side with NO entry here is NEVER dropped: the matcher synthesises
 * `unknown product` (the `attribution.ts` ledger-row idiom) so it keeps its kind
 * and lands in `excludedProducts` as 'undecomposable' when it carries one.
 */
export type ProductFacts = {
  productId: number;
  productName: string;
  baseName: string | null;
  unit: string | null;
  hundredths: number | null;
};

/** P2-D only; P2-A passes `[]`. */
export type Declaration = {
  fromProductId: number;
  fromUnits: number;
  toProductId: number;
  toUnits: number;
};

export type PerProduct = {
  productId: number;
  productName: string;
  ordered: number;
  deducted: number;   // out - corrected (may be negative -> overrun)
  corrected: number;
  delta: number;      // deducted - ordered
  kind: MatchKind | null;   // AFTER tolerance
  units: number;      // the kind's magnitude; 0 when kind null
  fromBundle: boolean; // true when any ORDERED line for this product came from a bundle (seam-check fix, pack REV-6)
};

export type ToleranceReport = {
  /** ONLY the groups that BALANCED. `massHundredths` is the balanced total (2 x 5 mg vs 1 x 10 mg -> 1000). */
  equivalentGroups: Array<{
    familyKey: string;
    unit: MatcherUnit;
    massHundredths: number;
    shortfall: Array<{ productId: number; units: number; hundredths: number }>;
    extra: Array<{ productId: number; units: number; hundredths: number }>;
  }>;
  /** P2-D; [] in P2-A. */
  declaredPairs: Declaration[];
  /** Products carrying a comparable kind that could not enter a group. */
  excludedProducts: Array<{
    productId: number;
    reason: 'undecomposable' | 'unit-refused';
    unit: string | null;
  }>;
};

export type OrderMatch = {
  class: MatchClassKey | null;      // null ONLY with reason 'unmatchable'
  reason?: typeof UNMATCHABLE;
  flagged: boolean;
  kinds: MatchKind[];               // K after tolerance, in MATCH_KINDS order
  perProduct: PerProduct[];         // every product on EITHER side, sorted by productId
  unmappedLines: number;
  unmappedUnits: number;
  bundleLines: number;
  unresolvableBundleLines: number;
  deductedUnits: number;            // sum of `out` over the deducted side (the unmatchable case reads it)
  tolerance: ToleranceReport | null;
  definitions: Readonly<Record<string, string>>;
};

/** The kinds a mass balance may cancel — `overrun` is history, never a swap. */
const COMPARABLE_KINDS: ReadonlySet<MatchKind> = new Set<MatchKind>([
  'missing',
  'short',
  'over',
  'extra',
]);

const SHORTFALL_KINDS: ReadonlySet<MatchKind> = new Set<MatchKind>(['missing', 'short']);

/**
 * THE ONE error the matcher throws on purpose (FD-2): its guards refusing
 * data that is not a unit count. The producer catches EXACTLY this class per
 * order and lets every other throw — a defect, not a refusal — propagate.
 */
export class MatcherRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatcherRefusal';
  }
}

/**
 * The guards' refusal. Units are integers by construction (the ledger's `delta`
 * is an INT and `quantity` is an INT), so a fractional or negative one means a
 * caller handed the matcher something that is not a unit count — and silently
 * rounding it would put a made-up number on an admin's screen. The producer
 * catches `MatcherRefusal` per order; nothing else this module throws is caught.
 */
function assertUnits(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new MatcherRefusal(`matchOrder: ${what} must be a non-negative integer, got ${value}`);
  }
}

/** The working row: the per-product facts plus the kind, which tolerances mutate. */
type WorkingRow = {
  productId: number;
  facts: ProductFacts;
  ordered: number;
  out: number;
  corrected: number;
  deducted: number;
  kind: MatchKind | null;
  units: number;
  fromBundle: boolean;
};

function unknownProduct(productId: number): ProductFacts {
  return { productId, productName: 'unknown product', baseName: null, unit: null, hundredths: null };
}

/** Spec §2.3(2): the per-product difference, before any tolerance. */
function rawKind(ordered: number, deducted: number): { kind: MatchKind | null; units: number } {
  if (deducted < 0) return { kind: 'overrun', units: -deducted };
  if (ordered === deducted) return { kind: null, units: 0 };
  if (ordered > 0 && deducted === 0) return { kind: 'missing', units: ordered };
  if (ordered > 0 && deducted < ordered) return { kind: 'short', units: ordered - deducted };
  if (ordered > 0 && deducted > ordered) return { kind: 'over', units: deducted - ordered };
  if (ordered === 0 && deducted > 0) return { kind: 'extra', units: deducted };
  return { kind: null, units: 0 };
}

function toPerProduct(row: WorkingRow): PerProduct {
  return {
    productId: row.productId,
    productName: row.facts.productName,
    ordered: row.ordered,
    deducted: row.deducted,
    corrected: row.corrected,
    delta: row.deducted - row.ordered,
    kind: row.kind,
    units: row.units,
    fromBundle: row.fromBundle,
  };
}

/**
 * Match one order's two sides.
 *
 * The algorithm is spec §2.3/§2.4 in order: the evaluability test, the raw
 * kinds, the declared pairs (P2-D; a no-op on `[]`), the mass balance, then the
 * class from the surviving kind SET.
 */
export function matchOrder(input: {
  items: OrderItems;
  deducted: DeductedProduct[];
  products: ProductFacts[];
  declarations?: Declaration[];
}): OrderMatch {
  const { items, deducted: deductedRows, products } = input;
  const declarations = input.declarations ?? [];

  // `fulfilledQty` is NOT guarded (pack REV-7): P2-A derives no figure from it —
  // P2-D does — and a guard on a field this wave never reads refused a whole
  // page of orders over a number nothing on the screen depends on.
  for (const l of items.lines) {
    assertUnits(l.quantity, `ordered quantity for product ${l.productId}`);
  }
  for (const d of deductedRows) {
    assertUnits(d.out, `deducted units for product ${d.productId}`);
    assertUnits(d.corrected, `corrected units for product ${d.productId}`);
  }

  const factsById = new Map<number, ProductFacts>();
  for (const p of products) {
    if (p.hundredths !== null && !Number.isInteger(p.hundredths)) {
      throw new MatcherRefusal(
        `matchOrder: hundredths for product ${p.productId} must be an integer, got ${p.hundredths}`,
      );
    }
    factsById.set(p.productId, p);
  }

  const orderedById = new Map<number, number>();
  const bundleIds = new Set<number>();
  for (const l of items.lines) {
    orderedById.set(l.productId, (orderedById.get(l.productId) ?? 0) + l.quantity);
    if (l.fromBundle) bundleIds.add(l.productId);
  }
  const outById = new Map<number, number>();
  const correctedById = new Map<number, number>();
  let deductedUnits = 0;
  for (const d of deductedRows) {
    outById.set(d.productId, (outById.get(d.productId) ?? 0) + d.out);
    correctedById.set(d.productId, (correctedById.get(d.productId) ?? 0) + d.corrected);
    deductedUnits += d.out;
  }

  const counts = {
    unmappedLines: items.unmappedLines,
    unmappedUnits: items.unmappedUnits,
    bundleLines: items.bundleLines,
    unresolvableBundleLines: items.unresolvableBundleLines,
  };

  // ---- 1. evaluability -----------------------------------------------------
  // No ordered line at all: nothing to compare against. The deducted products
  // are still LISTED (ordered 0, no kind) so the panel can show what left.
  if (items.lines.length === 0) {
    const outIds = Array.from(outById.keys()).sort((a, b) => a - b);
    return {
      class: null,
      reason: UNMATCHABLE,
      flagged: false,
      kinds: [],
      perProduct: outIds.map((productId) => {
        const out = outById.get(productId) ?? 0;
        const corrected = correctedById.get(productId) ?? 0;
        return toPerProduct({
          productId,
          facts: factsById.get(productId) ?? unknownProduct(productId),
          ordered: 0,
          out,
          corrected,
          deducted: out - corrected,
          kind: null,
          units: 0,
          fromBundle: false,
        });
      }),
      ...counts,
      deductedUnits,
      tolerance: null,
      definitions: MATCH_DEFINITIONS,
    };
  }

  // ---- 2/3. the two sides, and the raw kind per product --------------------
  const ids = Array.from(
    new Set(Array.from(orderedById.keys()).concat(Array.from(outById.keys()))),
  ).sort((a, b) => a - b);
  const rows: WorkingRow[] = ids.map((productId) => {
    const ordered = orderedById.get(productId) ?? 0;
    const out = outById.get(productId) ?? 0;
    const corrected = correctedById.get(productId) ?? 0;
    const deducted = out - corrected;
    const { kind, units } = rawKind(ordered, deducted);
    return {
      productId,
      facts: factsById.get(productId) ?? unknownProduct(productId),
      ordered,
      out,
      corrected,
      deducted,
      kind,
      units,
      fromBundle: bundleIds.has(productId),
    };
  });
  const rowsById = new Map(rows.map((r) => [r.productId, r]));

  // ---- 4. declared pairs (P2-D; a no-op on []) -----------------------------
  const declaredPairs: Declaration[] = [];
  for (const pair of declarations) {
    let reduced = false;
    const from = rowsById.get(pair.fromProductId);
    if (from !== undefined && from.kind !== null && SHORTFALL_KINDS.has(from.kind)) {
      const take = Math.min(from.units, Math.max(0, pair.fromUnits));
      if (take > 0) {
        from.units -= take;
        if (from.units === 0) from.kind = null;
        reduced = true;
      }
    }
    const to = rowsById.get(pair.toProductId);
    if (to !== undefined && (to.kind === 'over' || to.kind === 'extra')) {
      const take = Math.min(to.units, Math.max(0, pair.toUnits));
      if (take > 0) {
        to.units -= take;
        if (to.units === 0) to.kind = null;
        reduced = true;
      }
    }
    if (reduced) declaredPairs.push(pair);
  }
  const declaredApplied = declaredPairs.length > 0;

  // ---- 5. the mass balance, per (familyKey, unit) group --------------------
  type Group = {
    familyKey: string;
    unit: MatcherUnit;
    members: Array<{ row: WorkingRow; hundredths: number }>;
  };
  const groups = new Map<string, Group>();
  const excludedProducts: ToleranceReport['excludedProducts'] = [];

  for (const row of rows) {
    if (row.kind === null || !COMPARABLE_KINDS.has(row.kind)) continue;
    const { baseName, unit, hundredths } = row.facts;
    const family = baseName === null ? '' : familyKey(baseName);
    const admitted = matcherUnit(unit);
    if (family === '' || hundredths === null || hundredths <= 0 || admitted === null) {
      excludedProducts.push({
        productId: row.productId,
        // `unit-refused` is a claim about a unit that WAS written down and the
        // matcher would not admit — something an admin can go and fix. An empty
        // or whitespace-only unit is nothing written down at all, which is what
        // `undecomposable` already says (pack REV-7).
        reason:
          unit !== null && unit.trim() !== '' && admitted === null
            ? 'unit-refused'
            : 'undecomposable',
        unit,
      });
      continue;
    }
    const key = `${family} ${admitted}`;
    const group = groups.get(key) ?? { familyKey: family, unit: admitted, members: [] };
    group.members.push({ row, hundredths });
    groups.set(key, group);
  }

  const equivalentGroups: ToleranceReport['equivalentGroups'] = [];
  for (const group of Array.from(groups.values())) {
    let shortfallMass = 0;
    let extraMass = 0;
    for (const m of group.members) {
      const mass = m.row.units * m.hundredths;
      if (m.row.kind !== null && SHORTFALL_KINDS.has(m.row.kind)) shortfallMass += mass;
      else extraMass += mass;
    }
    if (shortfallMass === 0 || shortfallMass !== extraMass) continue;

    equivalentGroups.push({
      familyKey: group.familyKey,
      unit: group.unit,
      massHundredths: shortfallMass,
      shortfall: group.members
        .filter((m) => m.row.kind !== null && SHORTFALL_KINDS.has(m.row.kind))
        .map((m) => ({ productId: m.row.productId, units: m.row.units, hundredths: m.hundredths })),
      extra: group.members
        .filter((m) => m.row.kind !== null && !SHORTFALL_KINDS.has(m.row.kind))
        .map((m) => ({ productId: m.row.productId, units: m.row.units, hundredths: m.hundredths })),
    });
    for (const m of group.members) {
      m.row.kind = null;
      m.row.units = 0;
    }
  }
  const equivalentApplied = equivalentGroups.length > 0;

  // ---- 6. the class, from the surviving kind SET ---------------------------
  const K = new Set<MatchKind>();
  for (const row of rows) if (row.kind !== null) K.add(row.kind);
  const only = (kind: MatchKind) => K.size === 1 && K.has(kind);

  let cls: MatchClassKey;
  if (K.size === 0) {
    cls = equivalentApplied
      ? 'substitution-equivalent'
      : declaredApplied
        ? 'substitution-declared'
        : 'exact';
  } else if (K.has('overrun')) {
    cls = 'correction-overrun';
  } else if (only('missing')) {
    cls = 'missing-product';
  } else if (only('short')) {
    cls = 'short';
  } else if (only('over')) {
    cls = 'over';
  } else if (only('extra')) {
    cls = 'extra-product';
  } else if (K.size === 2 && K.has('missing') && K.has('extra')) {
    cls = 'substitution';
  } else {
    cls = 'mixed';
  }

  // ---- 7. the envelope -----------------------------------------------------
  const hasTolerance =
    equivalentGroups.length > 0 || declaredPairs.length > 0 || excludedProducts.length > 0;

  return {
    class: cls,
    flagged: FLAGGED_MATCH_CLASSES.has(cls),
    kinds: MATCH_KINDS.filter((k) => K.has(k)),
    perProduct: rows.map(toPerProduct),
    ...counts,
    deductedUnits,
    tolerance: hasTolerance ? { equivalentGroups, declaredPairs, excludedProducts } : null,
    definitions: MATCH_DEFINITIONS,
  };
}
