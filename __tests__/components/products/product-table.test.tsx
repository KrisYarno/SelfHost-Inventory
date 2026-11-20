/** @jest-environment jsdom */
//
// Facelift F2-8 — `ProductTable`, the List view at `lg` and up (plan
// 2026-11-19-facelift-f2: F2-8 as amended by Kris's cost decision (REV 2) and
// B10, A15, B12).
//   - `hidden lg:table w-full`; body rows `h-12`;
//   - columns: Product (baseName, muted variant, pending badge), Stock (right,
//     F2-6's total + state), Here ({location}) (`{n}` / `No record`; OMITTED
//     with no confirmed location or a mismatched echo), Cost and Retail
//     (EVERY user — B10: a member sees them; `$` 2 decimals, `Not set` muted),
//     and the "…" (REV 5 C2: its header is a `w-12` th with an sr-only `Actions`);
//   - rows are not clickable; the "…" carries the actions;
//   - B12: no duplicate ids with the row, the tile and the table all mounted.

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductTable } from "@/components/products/product-table";
import { ProductRow } from "@/components/products/product-row";
import { ProductGridTile } from "@/components/products/product-grid-tile";
import type { ProductWithQuantity } from "@/types/product";

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

const make = (over: Record<string, unknown>) =>
  ({
    approvalStatus: "APPROVED",
    variant: null,
    currentQuantity: 0,
    costPrice: null,
    retailPrice: null,
    ...over,
  }) as unknown as ProductWithQuantity;

// Prices arrive over JSON as Prisma Decimal strings.
const PRODUCTS = [
  make({ id: 1, name: "Alpha 5mg", baseName: "Alpha", variant: "5mg", totalQuantity: 48, hereQuantity: 4, stockState: "low", costPrice: "12.5", retailPrice: "30" }),
  make({ id: 2, name: "Beta", baseName: "Beta", totalQuantity: null, hereQuantity: null, stockState: "no-record", approvalStatus: "PENDING_REVIEW" }),
  make({ id: 3, name: "Gamma", baseName: "Gamma", totalQuantity: 0, hereQuantity: 0, stockState: "out", costPrice: 3, retailPrice: null }),
];

const MAIN = { id: 1, name: "Main" };

function renderTable({
  isAdmin = false,
  here = 1 as number | null | undefined,
  location = MAIN as { id: number; name: string } | null,
  handlers = {} as { onAdjust?: jest.Mock; onStockIn?: jest.Mock; onEdit?: jest.Mock; onDelete?: jest.Mock },
} = {}) {
  const onAdjust = handlers.onAdjust ?? jest.fn();
  const onStockIn = handlers.onStockIn ?? jest.fn();
  const utils = render(
    <ProductTable
      products={PRODUCTS}
      isAdmin={isAdmin}
      hereLocationId={here}
      selectedLocation={location}
      onAdjust={onAdjust}
      onStockIn={onStockIn}
      onEdit={handlers.onEdit}
      onDelete={handlers.onDelete}
    />
  );
  return { ...utils, onAdjust, onStockIn };
}

const headers = () => screen.getAllByRole("columnheader").map((th) => th.textContent);
const bodyRows = () => within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");
const cellOf = (rowIndex: number, header: string) => {
  const col = headers().indexOf(header);
  if (col < 0) throw new Error(`no column ${header}`);
  return within(bodyRows()[rowIndex]).getAllByRole("cell")[col];
};

describe("F2-8 ProductTable — the frame", () => {
  it("is a <table> at hidden lg:table w-full; body rows are h-12", () => {
    renderTable();
    const table = screen.getByRole("table");
    expect(table.tagName).toBe("TABLE");
    expect(table).toHaveClass("hidden", "lg:table", "w-full");
    expect(bodyRows()).toHaveLength(3);
    for (const row of bodyRows()) expect(row).toHaveClass("h-12");
  });
});

describe("F2-8 / B10 — the columns", () => {
  it("B10: a MEMBER sees Product, Stock, Here (Main), Cost, Retail and the actions column", () => {
    renderTable({ isAdmin: false });
    expect(headers()).toEqual(["Product", "Stock", "Here (Main)", "Cost", "Retail", "Actions"]);
  });

  it("an admin sees the same columns", () => {
    renderTable({ isAdmin: true });
    expect(headers()).toEqual(["Product", "Stock", "Here (Main)", "Cost", "Retail", "Actions"]);
  });

  it("C2 (REV 5 R8): the actions header is <th className=\"w-12\"> holding an sr-only `Actions`", () => {
    renderTable();
    const th = screen.getByRole("columnheader", { name: "Actions" });
    expect(th.tagName).toBe("TH");
    expect(th.getAttribute("class")).toBe("w-12");
    expect(th.children).toHaveLength(1);
    const label = th.firstElementChild as HTMLElement;
    expect(label.tagName).toBe("SPAN");
    expect(label.getAttribute("class")).toBe("sr-only");
    expect(label.textContent).toBe("Actions");
    // It is the last column, over the "…" cells.
    expect(screen.getAllByRole("columnheader").at(-1)).toBe(th);
  });

  it("Cost and Retail: $ with 2 decimals; null reads Not set, muted (member and admin alike)", () => {
    for (const isAdmin of [false, true]) {
      const { unmount } = renderTable({ isAdmin });
      expect(cellOf(0, "Cost")).toHaveTextContent(/^\$12\.50$/);
      expect(cellOf(0, "Retail")).toHaveTextContent(/^\$30\.00$/);
      expect(cellOf(2, "Cost")).toHaveTextContent(/^\$3\.00$/);
      const notSet = within(cellOf(2, "Retail")).getByText("Not set", { exact: true });
      expect(notSet).toHaveClass("text-muted-foreground");
      expect(within(cellOf(1, "Cost")).getByText("Not set")).toHaveClass("text-muted-foreground");
      unmount();
    }
  });

  it("Product: baseName, the variant muted, and the pending badge", () => {
    renderTable();
    expect(within(cellOf(0, "Product")).getByText("Alpha")).toBeInTheDocument();
    expect(within(cellOf(0, "Product")).getByText("5mg")).toHaveClass("text-xs", "text-muted-foreground");
    expect(within(cellOf(0, "Product")).queryByText("Pending review")).toBeNull();
    expect(within(cellOf(1, "Product")).getByText("Pending review")).toBeInTheDocument();
  });

  it("Stock: right-aligned, the total and the state word, and NO here line", () => {
    renderTable();
    expect(screen.getByRole("columnheader", { name: "Stock" })).toHaveClass("text-right");
    const stock = cellOf(0, "Stock");
    expect(stock).toHaveClass("text-right");
    expect(within(stock).getByText("48")).toBeInTheDocument();
    expect(within(stock).getByText("Low")).toBeInTheDocument();
    expect(stock).not.toHaveTextContent(/here/);
    // A null total: the — and the No record badge.
    expect(within(cellOf(1, "Stock")).getByText("—")).toHaveAttribute("aria-hidden", "true");
    expect(within(cellOf(1, "Stock")).getByText("No record")).toBeInTheDocument();
  });
});

describe("F2-8 / A15 — the Here column", () => {
  it("values: {n}, No record for null, 0 for a 0 row", () => {
    renderTable();
    expect(cellOf(0, "Here (Main)")).toHaveTextContent(/^4$/);
    expect(cellOf(1, "Here (Main)")).toHaveTextContent(/^No record$/);
    expect(cellOf(2, "Here (Main)")).toHaveTextContent(/^0$/);
  });

  it("OMITTED with no confirmed location (header and cells)", () => {
    renderTable({ location: null, here: null });
    expect(headers()).toEqual(["Product", "Stock", "Cost", "Retail", "Actions"]);
    for (const row of bodyRows()) expect(within(row).getAllByRole("cell")).toHaveLength(5);
  });

  it("OMITTED when the echo does not match the confirmed location", () => {
    renderTable({ location: { id: 2, name: "Annex" }, here: 1 });
    expect(headers()).toEqual(["Product", "Stock", "Cost", "Retail", "Actions"]);
    expect(screen.queryByText(/^Here/)).toBeNull();
  });

  it("OMITTED when the answer carries no echo (null, or no field at all)", () => {
    const { unmount } = renderTable({ here: null });
    expect(headers()).toEqual(["Product", "Stock", "Cost", "Retail", "Actions"]);
    unmount();
    // Rendered directly: `renderTable`'s default would replace an undefined `here`.
    render(
      <ProductTable products={PRODUCTS} isAdmin={false} hereLocationId={undefined} selectedLocation={MAIN} onAdjust={jest.fn()} onStockIn={jest.fn()} />
    );
    expect(headers()).toEqual(["Product", "Stock", "Cost", "Retail", "Actions"]);
  });
});

describe("F2-8 — rows are not clickable; the \"…\" carries the actions", () => {
  it("the only buttons are the per-row \"…\" triggers, and clicking a row does nothing", async () => {
    const user = userEvent.setup();
    const { onAdjust } = renderTable();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "More actions for Alpha 5mg",
      "More actions for Beta",
      "More actions for Gamma",
    ]);
    await user.click(cellOf(0, "Product"));
    await user.click(bodyRows()[1]);
    expect(onAdjust).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("each row owns its menu: opening Beta's opens only Beta's, and its Adjust stock gets Beta", async () => {
    const user = userEvent.setup();
    const onEdit = jest.fn();
    const { onAdjust } = renderTable({ isAdmin: true, handlers: { onEdit, onDelete: jest.fn() } });
    await user.click(screen.getByRole("button", { name: "More actions for Beta" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "More actions for Beta", hidden: true })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "More actions for Alpha 5mg", hidden: true })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Adjust stock" }));
    expect(onAdjust).toHaveBeenCalledTimes(1);
    expect(onAdjust).toHaveBeenCalledWith(PRODUCTS[1]);
  });
});

describe("B12 — no duplicate ids with the row, the tile and the table all mounted", () => {
  it("every id in the document is unique, and every describedby id resolves to exactly one element", async () => {
    const user = userEvent.setup();
    const common = { isAdmin: true, hereLocationId: 1, selectedLocationId: 1, onAdjust: jest.fn(), onStockIn: jest.fn(), onEdit: jest.fn(), onDelete: jest.fn() };
    render(
      <>
        <div className="lg:hidden">
          {PRODUCTS.map((p) => <ProductRow key={p.id} product={p} {...common} />)}
        </div>
        <div>
          {PRODUCTS.map((p) => <ProductGridTile key={p.id} product={p} {...common} />)}
        </div>
        <ProductTable products={PRODUCTS} isAdmin hereLocationId={1} selectedLocation={MAIN} onAdjust={jest.fn()} onStockIn={jest.fn()} />
      </>
    );
    // Open one menu too, so its content ids are in the document.
    await user.click(screen.getAllByRole("button", { name: "More actions for Beta" })[0]);

    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    const described = Array.from(document.querySelectorAll("[aria-describedby]"));
    expect(described.length).toBeGreaterThanOrEqual(PRODUCTS.length * 2);
    for (const el of described) {
      for (const id of el.getAttribute("aria-describedby")!.split(" ")) {
        expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
      }
    }
  });
});

describe("FR1-8 — a product with no base name still has a title", () => {
  it.each([null, ""])("baseName %p: the Product cell's title reads the product's name", (baseName) => {
    render(
      <ProductTable
        products={[make({ id: 4, name: "Delta 2mg", baseName, totalQuantity: 3, hereQuantity: 3, stockState: "low" })]}
        isAdmin={false}
        hereLocationId={1}
        selectedLocation={MAIN}
        onAdjust={jest.fn()}
        onStockIn={jest.fn()}
      />
    );
    const cell = within(bodyRows()[0]).getAllByRole("cell")[0];
    const title = cell.querySelector(".font-semibold") as HTMLElement;
    expect(title).not.toBeNull();
    expect(title.textContent).toBe("Delta 2mg");
  });
});
