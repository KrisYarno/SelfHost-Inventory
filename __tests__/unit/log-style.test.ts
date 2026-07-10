// @jest-environment node
//
// Phase C (P-C9): getInventoryLogTone gives every ledger logType a distinct human label.
// The old code labelled a POSITIVE ADJUSTMENT "Stock In" — a collision now that STOCK_IN
// is its own type. ADJUSTMENT's label is the single canonical "Adjustment" (delta conveys sign).
import { getInventoryLogTone } from "@/components/logs/log-style";
import { inventory_logs_logType } from "@prisma/client";

const ALL_TYPES = Object.values(inventory_logs_logType);

test("all six enum members map to distinct, human labels", () => {
  const labels = ALL_TYPES.map((t) => getInventoryLogTone(t, 1).label);
  expect(new Set(labels).size).toBe(ALL_TYPES.length);
  expect(labels.sort()).toEqual(
    ["Adjustment", "Correction", "Count", "Sale", "Stock In", "Transfer"].sort()
  );
});

test("expected label per type", () => {
  expect(getInventoryLogTone("STOCK_IN", 5).label).toBe("Stock In");
  expect(getInventoryLogTone("SALE", -3).label).toBe("Sale");
  expect(getInventoryLogTone("CORRECTION", -2).label).toBe("Correction");
  expect(getInventoryLogTone("COUNT", 0).label).toBe("Count");
  expect(getInventoryLogTone("TRANSFER", 1).label).toBe("Transfer");
  expect(getInventoryLogTone("ADJUSTMENT", 1).label).toBe("Adjustment");
});

test("ADJUSTMENT is 'Adjustment' for BOTH signs — never the old 'Stock In' collision", () => {
  expect(getInventoryLogTone("ADJUSTMENT", 7).label).toBe("Adjustment");
  expect(getInventoryLogTone("ADJUSTMENT", -7).label).toBe("Adjustment");
  expect(getInventoryLogTone("ADJUSTMENT", 7).label).not.toBe("Stock In");
});

test("unknown logType falls back to the raw string label", () => {
  expect(getInventoryLogTone("SOMETHING_NEW", 1).label).toBe("SOMETHING_NEW");
});
