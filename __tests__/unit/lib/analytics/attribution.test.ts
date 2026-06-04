import { attributeOrderItems, AttributableItem } from "@/lib/analytics/attribution";

const order = (over: Partial<AttributableItem["order"]> = {}) => ({
  companyId: "c1", integrationId: "i1", internalStatus: "processing",
  externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), id: "o1", ...over,
});
const key = (p: number) => `${p}|c1|i1|2026-06-04`;

test("non-bundle line: units + direct revenue (cents)", () => {
  const r = attributeOrderItems([{ quantity: 3, fulfilledQty: 2, price: "5.00",
    productLink: { internalProductId: 42, isBundle: false }, bundleComponentSnapshot: null, order: order() }]);
  const f = r.facts.get(key(42))!;
  expect(f).toMatchObject({ productId: 42, orderedQty: 3, fulfilledQty: 2, revenueCents: 1500 });
  expect(f.orderIds.has("o1")).toBe(true);
  expect(r.unattributed).toBe(0);
});

test("bundle line: component UNITS only, revenue stays 0 (ER2)", () => {
  const r = attributeOrderItems([{ quantity: 2, fulfilledQty: 1, price: "9.99",
    productLink: { internalProductId: null, isBundle: true },
    bundleComponentSnapshot: [{ internalProductId: 7, quantity: 3 }, { internalProductId: 8, quantity: 1 }], order: order() }]);
  expect(r.facts.get(key(7))).toMatchObject({ orderedQty: 6, fulfilledQty: 3, revenueCents: 0 });
  expect(r.facts.get(key(8))).toMatchObject({ orderedQty: 2, fulfilledQty: 1, revenueCents: 0 });
  expect(r.unattributed).toBe(0);
});

test("cancelled order is excluded entirely", () => {
  const r = attributeOrderItems([{ quantity: 1, fulfilledQty: 0, price: "5.00",
    productLink: { internalProductId: 42, isBundle: false }, bundleComponentSnapshot: null, order: order({ internalStatus: "cancelled" }) }]);
  expect(r.facts.size).toBe(0);
});

test("bundle with NULL snapshot => unattributed, NO live fallback (Pillar-2)", () => {
  const r = attributeOrderItems([{ quantity: 1, fulfilledQty: 0, price: "5.00",
    productLink: { internalProductId: null, isBundle: true }, bundleComponentSnapshot: null, order: order() }]);
  expect(r.facts.size).toBe(0);
  expect(r.unattributed).toBe(1);
});

test("mapped but unresolvable (internalProductId null, not bundle) => unattributed", () => {
  const r = attributeOrderItems([{ quantity: 1, fulfilledQty: 0, price: "5.00",
    productLink: { internalProductId: null, isBundle: false }, bundleComponentSnapshot: null, order: order() }]);
  expect(r.unattributed).toBe(1);
});

test("unmapped item (no productLink) => unattributed", () => {
  const r = attributeOrderItems([{ quantity: 1, fulfilledQty: 0, price: "5.00",
    productLink: null, bundleComponentSnapshot: null, order: order() }]);
  expect(r.unattributed).toBe(1);
});

test("two items same grain accumulate; orderCount is distinct orders", () => {
  const base = { fulfilledQty: 0, price: "1.00", productLink: { internalProductId: 42, isBundle: false }, bundleComponentSnapshot: null };
  const r = attributeOrderItems([
    { ...base, quantity: 1, order: order({ id: "o1" }) },
    { ...base, quantity: 4, order: order({ id: "o1" }) },
    { ...base, quantity: 5, order: order({ id: "o2" }) },
  ]);
  const f = r.facts.get(key(42))!;
  expect(f.orderedQty).toBe(10);
  expect(f.orderIds.size).toBe(2);
});

test("bundle with EMPTY [] snapshot => unattributed (no fact)", () => {
  const r = attributeOrderItems([{ quantity: 1, fulfilledQty: 0, price: "5.00",
    productLink: { internalProductId: null, isBundle: true }, bundleComponentSnapshot: [], order: order() }]);
  expect(r.facts.size).toBe(0);
  expect(r.unattributed).toBe(1);
});

test("bundle with malformed component (missing quantity) => unattributed, no NaN fact", () => {
  const r = attributeOrderItems([{ quantity: 2, fulfilledQty: 0, price: "5.00",
    productLink: { internalProductId: null, isBundle: true },
    bundleComponentSnapshot: [{ internalProductId: 7 }] as any, order: order() }]);
  expect(r.facts.size).toBe(0);
  expect(r.unattributed).toBe(1);
});

test("bundle with malformed component (missing internalProductId) => unattributed, no undefined-keyed fact", () => {
  const r = attributeOrderItems([{ quantity: 2, fulfilledQty: 0, price: "5.00",
    productLink: { internalProductId: null, isBundle: true },
    bundleComponentSnapshot: [{ quantity: 3 }] as any, order: order() }]);
  expect(r.facts.size).toBe(0);
  expect(Array.from(r.facts.keys()).some(k => k.startsWith("undefined"))).toBe(false);
  expect(r.unattributed).toBe(1);
});
