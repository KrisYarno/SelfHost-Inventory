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
