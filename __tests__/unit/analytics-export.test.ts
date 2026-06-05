/** @jest-environment jsdom */
// T9 export-wiring contract. The hub CSV column set and the per-product export
// handlers are the two surfaces this task guarantees. Here we pin the hub CSV
// column contract via the exported pure helper (no rendering needed); the
// per-product PNG/CSV wiring is asserted in analytics-product-page.test.tsx.
jest.mock("@/lib/export-utils", () => ({
  exportToCSV: jest.fn(),
  exportChartAsImage: jest.fn(),
  generateExportFilename: jest.fn(() => "analytics-products_2026-06-05.csv"),
}));

import { buildHubCsvColumns } from "@/components/analytics/analytics-hub";

test("hub CSV columns cover name/stock/units/orders/revenue", () => {
  const cols = buildHubCsvColumns();
  expect(cols.map((c) => c.key)).toEqual([
    "name",
    "currentStock",
    "units",
    "orderCount",
    "revenue",
  ]);
});
