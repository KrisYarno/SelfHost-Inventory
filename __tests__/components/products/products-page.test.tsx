/** @jest-environment jsdom */
//
// Facelift F2-4 — the Products page frame and header (plan
// 2026-11-19-facelift-f2: F2-4 as amended by A21; F2-9's admin empty state
// gets its `onCreate` from here).
//   - F1's `<Page title="Products" actions={…}>` (default width); the page's
//     own inner scroller (`flex-1 overflow-auto`) is gone;
//   - admin header actions: a `Deleted` toggle (outline sm, `aria-pressed`,
//     `aria-label="Deleted products"`, Trash2, text from `sm` up; `secondary`
//     when pressed) and `Add Product` (sm, Plus, `aria-label="Add Product"`,
//     text from `sm` up). The Switch + Label pair is gone. Members get none;
//   - A21: the deleted view has `<h2 className="text-h3">Deleted products</h2>`
//     above the list.

import * as React from "react";
import fs from "fs";
import path from "path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useSession } from "next-auth/react";

type ListProps = {
  isAdmin?: boolean;
  onCreate?: () => void;
  onEdit?: unknown;
  onDelete?: unknown;
  onQuickAdjust?: unknown;
  onStockIn?: unknown;
};
let listProps: ListProps | null = null;
jest.mock("@/components/products/product-list-optimized", () => ({
  ProductListOptimized: (props: ListProps) => {
    listProps = props;
    return <div data-testid="product-list" />;
  },
}));
jest.mock("@/components/products/deleted-products-list", () => ({
  DeletedProductsList: () => <div data-testid="deleted-list" />,
}));
let createOpen: boolean | null = null;
jest.mock("@/components/products/create-product-dialog", () => ({
  CreateProductDialog: ({ open }: { open: boolean }) => {
    createOpen = open;
    return null;
  },
}));
jest.mock("@/components/products/edit-product-dialog", () => ({ EditProductDialog: () => null }));
jest.mock("@/components/products/delete-product-dialog", () => ({ DeleteProductDialog: () => null }));
jest.mock("@/components/inventory/quick-adjust-dialog", () => ({ QuickAdjustDialog: () => null }));
jest.mock("@/components/inventory/stock-in-dialog", () => ({ StockInDialog: () => null }));

import ProductsPage from "@/app/(app)/products/page";

const asAdmin = (isAdmin: boolean) =>
  (useSession as jest.Mock).mockReturnValue({
    data: { user: { id: "1", isAdmin } },
    status: "authenticated",
  });

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const header = () => screen.getByRole("banner");

beforeEach(() => {
  listProps = null;
  createOpen = null;
});

describe("F2-4 — the frame", () => {
  it("one h1 `Products`, inside F1's Page (default width)", () => {
    asAdmin(true);
    const { container } = render(<ProductsPage />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/^Products$/);
    expect(container.firstElementChild).toHaveClass("px-4", "sm:px-6", "py-4", "mx-auto", "max-w-7xl");
  });

  it("no inner overflow-auto scroller: the shell's <main> is the one scroller", () => {
    asAdmin(true);
    const { container } = render(<ProductsPage />);
    expect(container.querySelector(".overflow-auto, .overflow-y-auto")).toBeNull();
    const src = fs.readFileSync(path.join(process.cwd(), "app/(app)/products/page.tsx"), "utf8");
    expect(src).not.toMatch(/overflow-(y-)?auto/);
    expect(src).not.toMatch(/<\/?main[\s>]/);
  });
});

describe("F2-4 / A21 — the header actions", () => {
  it("admin: the Deleted toggle (outline sm, aria-pressed false, Trash2, `Deleted` from sm up) and Add Product (sm, Plus, text from sm up)", () => {
    asAdmin(true);
    render(<ProductsPage />);
    const buttons = within(header()).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Deleted products", "Add Product"]);

    const deleted = within(header()).getByRole("button", { name: "Deleted products" });
    expect(deleted).toHaveAttribute("aria-pressed", "false");
    expect(classesOf(deleted)).toEqual(expect.arrayContaining(["border-input", "h-8", "max-md:min-h-11", "max-md:min-w-11"]));
    expect(classesOf(deleted)).not.toContain("bg-secondary");
    expect(deleted.querySelector("svg.lucide-trash-2")).not.toBeNull();
    expect(classesOf(within(deleted).getByText("Deleted"))).toEqual(expect.arrayContaining(["hidden", "sm:inline"]));

    const add = within(header()).getByRole("button", { name: "Add Product" });
    expect(classesOf(add)).toEqual(expect.arrayContaining(["bg-primary", "h-8", "max-md:min-h-11", "max-md:min-w-11"]));
    expect(add.querySelector("svg.lucide-plus")).not.toBeNull();
    expect(classesOf(within(add).getByText("Add Product"))).toEqual(expect.arrayContaining(["hidden", "sm:inline"]));
  });

  it("the Switch + Label pair is gone", () => {
    asAdmin(true);
    render(<ProductsPage />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(document.querySelector("label")).toBeNull();
  });

  it("member: no header actions", () => {
    asAdmin(false);
    render(<ProductsPage />);
    expect(within(header()).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByTestId("product-list")).toBeInTheDocument();
  });

  it("Add Product opens the create dialog", () => {
    asAdmin(true);
    render(<ProductsPage />);
    expect(createOpen).toBe(false);
    fireEvent.click(within(header()).getByRole("button", { name: "Add Product" }));
    expect(createOpen).toBe(true);
  });
});

describe("F2-4 / A21 — the Deleted toggle switches the view", () => {
  it("pressed: aria-pressed true, secondary, the `Deleted products` h2 (text-h3) above the deleted list; again: back to the list", () => {
    asAdmin(true);
    render(<ProductsPage />);
    const deleted = within(header()).getByRole("button", { name: "Deleted products" });
    expect(screen.getByTestId("product-list")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();

    fireEvent.click(deleted);
    expect(deleted).toHaveAttribute("aria-pressed", "true");
    expect(classesOf(deleted)).toContain("bg-secondary");
    expect(classesOf(deleted)).not.toContain("border-input");
    const h2 = screen.getByRole("heading", { level: 2, name: "Deleted products" });
    expect(h2.tagName).toBe("H2");
    expect(h2).toHaveClass("text-h3");
    const list = screen.getByTestId("deleted-list");
    expect(h2.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("product-list")).toBeNull();

    fireEvent.click(deleted);
    expect(deleted).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("product-list")).toBeInTheDocument();
    expect(screen.queryByTestId("deleted-list")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });
});

describe("F2-9 — the list's props from the page", () => {
  it("admin: onCreate opens the create dialog; edit and delete are handed over", () => {
    asAdmin(true);
    render(<ProductsPage />);
    expect(listProps!.isAdmin).toBe(true);
    expect(typeof listProps!.onEdit).toBe("function");
    expect(typeof listProps!.onDelete).toBe("function");
    expect(typeof listProps!.onQuickAdjust).toBe("function");
    expect(typeof listProps!.onStockIn).toBe("function");
    expect(createOpen).toBe(false);
    React.act(() => listProps!.onCreate!());
    expect(createOpen).toBe(true);
  });

  it("member: no onCreate, no edit or delete", () => {
    asAdmin(false);
    render(<ProductsPage />);
    expect(listProps!.isAdmin).toBe(false);
    expect(listProps!.onCreate).toBeUndefined();
    expect(listProps!.onEdit).toBeUndefined();
    expect(listProps!.onDelete).toBeUndefined();
    expect(typeof listProps!.onQuickAdjust).toBe("function");
  });
});
