// W1-VAL (spec §5 T-VAL, REV-2 contracts): get_valuation module math over a mocked
// prisma. getValuation groups by total|product|location and, per the truthful-data
// meta-rule, disclosed coverage counts BOTH products AND stocked units for every
// dimension (cost / retail / receipt / margin) so "1 known-price unit among 1,001"
// reads as 1/1001 units covered, never 50%.
//
// Pins (from the brief + spec §5 T-VAL):
//   * unit-vs-product coverage divergence (the 1-vs-1001 case)
//   * margin is the cost∧retail INTERSECTION subtotal, NOT atRetail − atCost
//   * a 0 retail is a KNOWN price (genuinely free) => margin computes against it
//   * receipt cost is PRODUCT-grain only; location rows carry null + a named reason
//   * total grain reproduces getValuationSummary's cost fields (old↔new consistency)
//   * deterministic ordering (productId / locationId asc)

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    inventory_logs: { groupBy: jest.fn(), findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getValuation, getValuationSummary } from "@/lib/analytics/valuation";

const m = prisma as unknown as {
  product: { findMany: jest.Mock };
  inventory_logs: { groupBy: jest.Mock; findMany: jest.Mock };
};

// product_locations factory: one Main-warehouse line by default.
const at = (locationId: number, quantity: number, name: string) => ({
  locationId,
  quantity,
  locations: { name },
});

const prod = (over: Partial<any> = {}) => ({
  id: 1,
  name: "P1",
  costPrice: null,
  retailPrice: null,
  product_locations: [at(1, 0, "Main")],
  ...over,
});

function setupVal(f: {
  products?: any[];
  receiptMax?: any[]; // inventory_logs.groupBy _max(changeTime) rows
  receiptRows?: any[]; // inventory_logs.findMany resolved receipt rows
}) {
  m.product.findMany.mockResolvedValue(f.products ?? []);
  m.inventory_logs.groupBy.mockResolvedValue(f.receiptMax ?? []);
  m.inventory_logs.findMany.mockResolvedValue(f.receiptRows ?? []);
}

beforeEach(() => jest.clearAllMocks());

describe("getValuation — unit vs product coverage divergence (spec §5 T-VAL, the 1-vs-1001 case)", () => {
  test("one known-price unit among 1,001 reads 1/1001 units, 1/2 products", async () => {
    setupVal({
      products: [
        prod({ id: 1, name: "A", costPrice: 5, retailPrice: 9, product_locations: [at(1, 1, "Main")] }),
        prod({ id: 2, name: "B", costPrice: null, retailPrice: null, product_locations: [at(1, 1000, "Main")] }),
      ],
    });
    const r = await getValuation({ groupBy: "total" });

    // products: 1 of 2 costed/retail/margin covered — but units diverge hard.
    expect(r.coverage.costedProducts).toBe(1);
    expect(r.coverage.ofProducts).toBe(2);
    expect(r.coverage.costedUnits).toBe(1); // NOT 1001
    expect(r.coverage.ofUnits).toBe(1001);
    expect(r.coverage.retailPricedProducts).toBe(1);
    expect(r.coverage.retailPricedUnits).toBe(1);
    expect(r.coverage.marginProducts).toBe(1);
    expect(r.coverage.marginUnits).toBe(1);

    // the single total row is a KNOWN-subtotal: only A contributes.
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].units).toBe(1001);
    expect(r.rows[0].atCurrentCostCents).toBe(500); // 1 x 500c
    expect(r.rows[0].atRetailCents).toBe(900); // 1 x 900c
    expect(r.rows[0].marginCents).toBe(400); // 1 x (900 − 500)
  });
});

describe("getValuation — margin is the cost∧retail intersection, never atRetail − atCost", () => {
  test("cost-only + retail-only products are excluded from margin; total margin ≠ atRetail − atCost", async () => {
    setupVal({
      products: [
        prod({ id: 1, costPrice: 2.5, retailPrice: 9, product_locations: [at(1, 2, "Main")] }), // both known
        prod({ id: 2, costPrice: 2.5, retailPrice: null, product_locations: [at(1, 3, "Main")] }), // cost only
        prod({ id: 3, costPrice: null, retailPrice: 9, product_locations: [at(1, 4, "Main")] }), // retail only
      ],
    });

    const p = await getValuation({ groupBy: "product" });
    const byId = Object.fromEntries(p.rows.map((row) => [row.productId, row]));
    expect(byId[1].marginCents).toBe(1300); // 2 x (900 − 250)
    expect(byId[2].marginCents).toBeNull(); // retail unknown
    expect(byId[2].atRetailCents).toBeNull();
    expect(byId[3].marginCents).toBeNull(); // cost unknown
    expect(byId[3].atCurrentCostCents).toBeNull();

    const t = await getValuation({ groupBy: "total" });
    // Coverage: only product 1 has both.
    expect(t.coverage.marginProducts).toBe(1);
    expect(t.coverage.marginUnits).toBe(2);
    expect(t.coverage.costedProducts).toBe(2); // 1 + 2
    expect(t.coverage.retailPricedProducts).toBe(2); // 1 + 3
    // Total margin is the intersection subtotal (1300), NOT the naive difference.
    const row = t.rows[0];
    expect(row.marginCents).toBe(1300);
    expect(row.atCurrentCostCents).toBe(1250); // 500 + 750
    expect(row.atRetailCents).toBe(5400); // 1800 + 3600
    expect(row.marginCents).not.toBe((row.atRetailCents ?? 0) - (row.atCurrentCostCents ?? 0)); // 4150
  });

  test("a 0 retail is a KNOWN price (genuinely free): atRetail = 0 and margin computes against it", async () => {
    setupVal({
      products: [prod({ id: 1, costPrice: 2.5, retailPrice: 0, product_locations: [at(1, 4, "Main")] })],
    });
    const r = await getValuation({ groupBy: "product" });
    expect(r.rows[0].atRetailCents).toBe(0); // known-free, NOT null
    expect(r.rows[0].marginCents).toBe(-1000); // 4 x (0 − 250) — a real negative margin
    expect(r.coverage.retailPricedProducts).toBe(1); // 0 counts as priced
    expect(r.coverage.marginProducts).toBe(1);
  });
});

describe("getValuation — product grain receipt values + coverage", () => {
  test("receipt cost values in-stock products with a receipt; coverage counts products AND units", async () => {
    setupVal({
      products: [
        prod({ id: 1, costPrice: 2, product_locations: [at(1, 10, "Main")] }), // in stock, has receipt
        prod({ id: 2, costPrice: 3, product_locations: [at(1, 5, "Main")] }), // in stock, no receipt
        prod({ id: 3, costPrice: 4, product_locations: [at(1, 0, "Main")] }), // out of stock
      ],
      receiptMax: [{ productId: 1, _max: { changeTime: new Date() } }],
      receiptRows: [{ id: 9, productId: 1, unitCostCents: 180 }],
    });
    const r = await getValuation({ groupBy: "product" });
    const byId = Object.fromEntries(r.rows.map((row) => [row.productId, row]));
    expect(byId[1].atReceiptCostCents).toBe(1800); // 10 x 180
    expect(byId[2].atReceiptCostCents).toBeNull(); // no STOCK_IN row
    expect(byId[3].atReceiptCostCents).toBeNull(); // out of stock, no receipt

    expect(r.coverage.receiptCostedProducts).toBe(1); // only product 1
    expect(r.coverage.receiptCostedUnits).toBe(10);
    expect(r.coverage.ofUnits).toBe(15);
  });
});

describe("getValuation — location grain: receipt is not location-attributable", () => {
  test("location rows sum cost/retail/margin per location; atReceiptCostCents null + named reason; locationId asc", async () => {
    setupVal({
      products: [
        prod({
          id: 1,
          costPrice: 2,
          retailPrice: 5,
          // locations given OUT of order (2 before 1) to prove the asc sort
          product_locations: [at(2, 3, "B-loc"), at(1, 7, "A-loc")],
        }),
        prod({
          id: 2,
          costPrice: null, // cost unknown at this product
          retailPrice: 5,
          product_locations: [at(1, 4, "A-loc")],
        }),
      ],
    });
    const r = await getValuation({ groupBy: "location" });

    expect(r.groupBy).toBe("location");
    expect(r.rows.map((row) => row.locationId)).toEqual([1, 2]); // deterministic asc

    const loc1 = r.rows[0];
    expect(loc1.name).toBe("A-loc");
    expect(loc1.units).toBe(11); // 7 + 4
    expect(loc1.atCurrentCostCents).toBe(1400); // 7 x 200 (product 2 has no cost)
    expect(loc1.atRetailCents).toBe(5500); // 7 x 500 + 4 x 500
    expect(loc1.marginCents).toBe(2100); // only product 1 both-known: 7 x (500 − 200)
    expect(loc1.atReceiptCostCents).toBeNull();
    expect(loc1.reasons?.atReceiptCostCents).toBe("receipt cost is not location-attributable");

    const loc2 = r.rows[1];
    expect(loc2.name).toBe("B-loc");
    expect(loc2.units).toBe(3);
    expect(loc2.atCurrentCostCents).toBe(600); // 3 x 200
    expect(loc2.marginCents).toBe(900); // 3 x (500 − 200)
    expect(loc2.atReceiptCostCents).toBeNull();
  });
});

describe("getValuation — total grain reproduces getValuationSummary's cost fields (old ↔ new consistency)", () => {
  test("atCurrentCostCents and atReceiptCostCents match the reference implementation on identical data", async () => {
    const fixture = {
      products: [
        prod({ id: 1, costPrice: 2.0, product_locations: [at(1, 10, "Main")] }), // has receipt
        prod({ id: 2, costPrice: 3.0, product_locations: [at(1, 5, "Main")] }), // no receipt
        prod({ id: 3, costPrice: 4.0, product_locations: [at(1, 0, "Main")] }), // out of stock
      ],
      receiptMax: [{ productId: 1, _max: { changeTime: new Date() } }],
      receiptRows: [{ id: 9, productId: 1, unitCostCents: 180 }],
    };

    setupVal(fixture);
    const summary = await getValuationSummary();

    setupVal(fixture);
    const v = await getValuation({ groupBy: "total" });

    expect(v.rows[0].atCurrentCostCents).toBe(summary.atCurrentCostCents); // 3500
    expect(v.rows[0].atReceiptCostCents).toBe(summary.atReceiptCostCents); // 1800
    expect(v.rows[0].atCurrentCostCents).toBe(3500);
    expect(v.rows[0].atReceiptCostCents).toBe(1800);
  });
});

describe("getValuation — deterministic product ordering + productId narrowing", () => {
  test("product rows come back productId asc even when the query result is unordered", async () => {
    setupVal({
      products: [
        prod({ id: 3, name: "C", costPrice: 1, product_locations: [at(1, 1, "Main")] }),
        prod({ id: 1, name: "A", costPrice: 1, product_locations: [at(1, 1, "Main")] }),
        prod({ id: 2, name: "B", costPrice: 1, product_locations: [at(1, 1, "Main")] }),
      ],
    });
    const r = await getValuation({ groupBy: "product" });
    expect(r.rows.map((row) => row.productId)).toEqual([1, 2, 3]);
    // determinism intent is also encoded in the query orderBy.
    expect(m.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: "asc" } }),
    );
  });

  test("productId is pushed into the where clause (narrowing is a DB filter)", async () => {
    setupVal({ products: [prod({ id: 42, costPrice: 1, product_locations: [at(1, 2, "Main")] })] });
    await getValuation({ productId: 42, groupBy: "total" });
    expect(m.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 42 }) }),
    );
  });

  test("an unknown/out-of-scope productId returns empty rows + zeroed coverage (not-found is the tool's job)", async () => {
    setupVal({ products: [] });
    const r = await getValuation({ productId: 999 });
    expect(r.groupBy).toBe("total"); // default echoed
    expect(r.rows).toEqual([]);
    expect(r.coverage.ofProducts).toBe(0);
    expect(r.coverage.ofUnits).toBe(0);
    expect(r.coverage.costedProducts).toBe(0);
    expect(r.coverage.marginProducts).toBe(0);
    expect(r.coverage.receiptCostedProducts).toBe(0);
  });
});
