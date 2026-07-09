/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { SimpleInventoryLogTable } from "@/components/inventory/simple-inventory-log-table";

test("empty state colSpan equals rendered column count", () => {
  render(<SimpleInventoryLogTable logs={[]} />);
  const cell = screen.getByRole("cell");
  const table = screen.getByRole("table");
  const headerCount = table.querySelectorAll("thead th").length;
  expect(Number(cell.getAttribute("colspan"))).toBe(headerCount);
});

test("mobile card list swaps at md (no sm: swap classes remain)", () => {
  const { container } = render(<SimpleInventoryLogTable logs={[]} />);
  expect(container.querySelector(".md\\:hidden")).not.toBeNull();
  expect(container.querySelector(".sm\\:hidden")).toBeNull();
});

// --- transferId exact pairing ---
// Minimal fixtures matching the component's log type (inventory_logs & users/products/locations).
const BASE_TIME = new Date("2026-06-09T12:00:00Z");
function transferLog(
  id: number,
  delta: number,
  transferId: string | null,
  secondsOffset = 0
) {
  return {
    id,
    userId: 1,
    productId: 7,
    delta,
    changeTime: new Date(BASE_TIME.getTime() + secondsOffset * 1000),
    locationId: delta < 0 ? 2 : 3,
    logType: "TRANSFER",
    transferId,
    users: { id: 1, username: "kris" },
    products: { id: 7, name: "Widget" },
    locations:
      delta < 0 ? { id: 2, name: "Shelf A" } : { id: 3, name: "Shelf B" },
  } as any;
}

test("two TRANSFER rows with the SAME transferId render as ONE paired entry", () => {
  const { container } = render(
    <SimpleInventoryLogTable
      logs={[
        transferLog(1, -5, "11111111-1111-4111-8111-111111111111"),
        transferLog(2, 5, "11111111-1111-4111-8111-111111111111", 2),
      ]}
    />
  );
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(1);
  // The paired row carries both sides of the transfer
  expect(rows[0].textContent).toContain("-5");
  expect(rows[0].textContent).toContain("+5");
  expect(rows[0].textContent).toContain("Transfer");
});

test("two TRANSFER rows with DIFFERENT transferIds stay SEPARATE even when the heuristic would pair them", () => {
  // Same product/user, within 5s, opposite deltas: the legacy heuristic alone
  // would mis-pair these; distinct transferIds must prevent it.
  const { container } = render(
    <SimpleInventoryLogTable
      logs={[
        transferLog(1, -5, "11111111-1111-4111-8111-111111111111"),
        transferLog(2, 5, "22222222-2222-4222-8222-222222222222", 2),
      ]}
    />
  );
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
});

// --- machine-actor (nullable userId) rows ---
test("a log with users: null renders the actor as 'System'", () => {
  // Change-tracking foundation: inventory_logs.userId is nullable, so machine-actor
  // rows arrive with users === null. The table must show "System", never crash.
  const machineLog = {
    id: 42,
    userId: null,
    productId: 7,
    delta: 3,
    changeTime: BASE_TIME,
    locationId: 2,
    logType: "STOCK_IN",
    transferId: null,
    users: null,
    products: { id: 7, name: "Widget" },
    locations: { id: 2, name: "Shelf A" },
  } as any;

  render(<SimpleInventoryLogTable logs={[machineLog]} />);
  // Desktop table cell + mobile card both render the "System" fallback.
  expect(screen.getAllByText("System").length).toBeGreaterThan(0);
});
