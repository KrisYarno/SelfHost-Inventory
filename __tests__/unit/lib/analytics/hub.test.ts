import { buildHubRows } from "@/lib/analytics/hub";

const candidates = [
  { id: 1, name: "Alpha", lowStockThreshold: 5 },
  { id: 2, name: "Bravo", lowStockThreshold: 10 },
  { id: 3, name: "Charlie", lowStockThreshold: null },
];

test("stock-only product (no sales) yields units=0 and revenue='0.00' (never null)", () => {
  const out = buildHubRows({
    candidates,
    stockByProduct: new Map([[1, 7]]),
    salesByProduct: new Map(),               // none have sales
    trendByProduct: new Map(),
    filter: "all", sort: "name", dir: "asc", page: 1, pageSize: 25,
  });
  expect(out.products[0]).toMatchObject({ productId: 1, units: 0, revenue: "0.00", currentStock: 7 });
  expect(out.products.find((p) => p.productId === 2)?.revenue).toBe("0.00");
  expect(out.total).toBe(3);
});

test("filter=low uses >0 && < threshold (null threshold defaults to 10)", () => {
  const out = buildHubRows({
    candidates,
    stockByProduct: new Map([[1, 3], [2, 12], [3, 9]]), // 1: 3<5 low; 2: 12>=10 not; 3: 9<10 low
    salesByProduct: new Map(),
    trendByProduct: new Map(),
    filter: "low", sort: "name", dir: "asc", page: 1, pageSize: 25,
  });
  expect(out.products.map((p) => p.productId).sort()).toEqual([1, 3]);
  expect(out.total).toBe(2);
});

test("filter=out keeps only currentStock===0; filter=in keeps >0", () => {
  const stock = new Map([[1, 0], [2, 5], [3, 0]]);
  const base = { candidates, salesByProduct: new Map(), trendByProduct: new Map(), sort: "name" as const, dir: "asc" as const, page: 1, pageSize: 25 };
  expect(buildHubRows({ ...base, stockByProduct: stock, filter: "out" }).products.map((p) => p.productId).sort()).toEqual([1, 3]);
  expect(buildHubRows({ ...base, stockByProduct: stock, filter: "in" }).products.map((p) => p.productId)).toEqual([2]);
});

test("sort=units desc orders by units across the FULL set, then paginates", () => {
  const out = buildHubRows({
    candidates,
    stockByProduct: new Map(),
    salesByProduct: new Map([
      [1, { units: 5, orderCount: 1, revenue: "5.00" }],
      [2, { units: 50, orderCount: 3, revenue: "9.00" }],
      [3, { units: 20, orderCount: 2, revenue: "1.00" }],
    ]),
    trendByProduct: new Map(),
    filter: "all", sort: "units", dir: "desc", page: 1, pageSize: 2,
  });
  expect(out.products.map((p) => p.productId)).toEqual([2, 3]); // top 2 by units
  expect(out.total).toBe(3); // total is the FULL set, not the page
  expect(out.page).toBe(1);
  expect(out.pageSize).toBe(2);
});

test("sort=revenue compares the numeric string value (not lexicographically)", () => {
  const out = buildHubRows({
    candidates: [candidates[0], candidates[1]],
    stockByProduct: new Map(),
    salesByProduct: new Map([
      [1, { units: 0, orderCount: 0, revenue: "9.00" }],
      [2, { units: 0, orderCount: 0, revenue: "100.00" }],
    ]),
    trendByProduct: new Map(),
    filter: "all", sort: "revenue", dir: "desc", page: 1, pageSize: 25,
  });
  expect(out.products.map((p) => p.productId)).toEqual([2, 1]); // 100 > 9 numerically
});

test("zero/equal metrics sort deterministically by productId (stable paging)", () => {
  const out = buildHubRows({
    candidates,
    stockByProduct: new Map(),
    salesByProduct: new Map(), // all units 0
    trendByProduct: new Map(),
    filter: "all", sort: "units", dir: "desc", page: 1, pageSize: 25,
  });
  expect(out.products.map((p) => p.productId)).toEqual([1, 2, 3]);
});
