/** @jest-environment jsdom */
//
// Facelift F2-10 — the deleted list (plan 2026-11-19-facelift-f2: F2-10, FL-B-14,
// A24's `Restore Product` bullet). The cards become ProductRow-style rows: ONE
// bordered `divide-y` container, rows `min-h-14 px-3`; the name is `text-sm
// font-semibold truncate` with NO line-through; the existing `Deleted {date}`
// and `by {user}` text sits on the second line; `Restore Product` is a
// `size="sm"` Button (44 px on phones via F1) with the `h-8 text-xs` override
// gone; `opacity-75` is dropped. Every existing string and behaviour is
// unchanged: the change is STRUCTURAL.

import * as React from "react";
import fs from "fs";
import path from "path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-t", isLoading: false, error: null }),
  withCSRFHeaders: (h: Record<string, string>, t: string) => ({ ...h, "x-csrf-token": t }),
}));
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => mockToastSuccess(...a), error: (...a: unknown[]) => mockToastError(...a) },
}));

import { DeletedProductsList } from "@/components/products/deleted-products-list";

type Deleted = {
  id: number;
  name: string;
  baseName?: string | null;
  variant?: string | null;
  deletedAt: string;
  deletedByUser?: { id: number; username: string; email: string } | null;
};

const PRODUCTS: Deleted[] = [
  {
    id: 5,
    name: "BPC 5 Vial",
    baseName: "BPC 5",
    variant: "Vial",
    deletedAt: "2026-11-12T12:00:00.000Z",
    deletedByUser: { id: 1, username: "kris", email: "k@example.test" },
  },
  { id: 6, name: "TB 500", baseName: null, variant: null, deletedAt: "2026-11-10T12:00:00.000Z", deletedByUser: null },
];

let listed: Deleted[] = [];
let restoreOk = true;
let fetchMock: jest.Mock;
let holdRestore: (() => void) | null = null;

beforeEach(() => {
  listed = PRODUCTS;
  restoreOk = true;
  holdRestore = null;
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/admin/products/deleted") {
      return { ok: true, json: async () => ({ products: listed }) } as Response;
    }
    const m = url.match(/^\/api\/admin\/products\/(\d+)\/restore$/);
    if (m && init?.method === "POST") {
      await new Promise<void>((go) => {
        if (holdRestore === null) go();
        else holdRestore = go;
      });
      return restoreOk
        ? ({ ok: true, json: async () => ({}) } as Response)
        : ({ ok: false, json: async () => ({ error: "Nope" }) } as Response);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DeletedProductsList />
    </QueryClientProvider>
  );
}

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const formatted = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

describe("F2-10 — rows, not cards", () => {
  it("ONE bordered divide-y container; each row min-h-14 px-3", async () => {
    renderList();
    const name = await screen.findByText("BPC 5 Vial");
    const row = name.closest(".min-h-14") as HTMLElement;
    expect(classesOf(row)).toEqual(expect.arrayContaining(["flex", "min-h-14", "items-center", "px-3"]));
    const frame = row.parentElement as HTMLElement;
    expect(classesOf(frame)).toEqual(expect.arrayContaining(["rounded-lg", "border", "bg-surface", "divide-y"]));
    expect(frame.children).toHaveLength(2);
    expect(frame).toContainElement(screen.getByText("TB 500"));
  });

  it("the name is text-sm font-semibold truncate, with NO line-through; nothing is dimmed (no opacity class)", async () => {
    const { container } = renderList();
    const name = await screen.findByText("BPC 5 Vial");
    expect(classesOf(name)).toEqual(expect.arrayContaining(["text-sm", "font-semibold", "truncate"]));
    const all = [container, ...Array.from(container.querySelectorAll("*"))];
    // An unprefixed opacity class dims always (a `disabled:` one is the Button's own).
    const dimmed = all.filter((el) => classesOf(el).some((c) => c === "line-through" || /^(hover:)?opacity-\d+$/.test(c)));
    expect(dimmed).toEqual([]);
  });

  it("the second line carries the existing `Deleted {date}` and `by {user}` text", async () => {
    renderList();
    const name = await screen.findByText("BPC 5 Vial");
    const row = name.closest(".min-h-14") as HTMLElement;
    const date = within(row).getByText(`Deleted ${formatted(PRODUCTS[0].deletedAt)}`);
    const by = within(row).getByText("by kris");
    expect(date.parentElement).toBe(by.parentElement);
    expect(date.parentElement).toHaveClass("text-xs", "text-muted-foreground");
    // The name's line comes first.
    expect(name.compareDocumentPosition(date) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Restore Product is a size=sm Button (44 px on phones), the h-8 text-xs / w-full override gone", async () => {
    renderList();
    await screen.findByText("BPC 5 Vial");
    const [restore] = screen.getAllByRole("button", { name: "Restore Product" });
    expect(classesOf(restore)).toEqual(expect.arrayContaining(["max-md:min-h-11", "max-md:min-w-11"]));
    expect(classesOf(restore)).not.toContain("w-full");
    // The override lived on the call site; the size's own classes remain.
    const src = fs.readFileSync(path.join(process.cwd(), "components/products/deleted-products-list.tsx"), "utf8");
    expect(src).not.toMatch(/h-8 w-full text-xs/);
    expect(src).not.toMatch(/opacity-75|line-through/);
    expect(src).not.toMatch(/<Card\b|CardHeader|CardTitle|CardContent/);
  });
});

describe("F2-10 / A24 — every existing string, unchanged", () => {
  it("the count, the Deleted badge, the base / variant line, the date, the user, Restore Product", async () => {
    renderList();
    expect(await screen.findByText("2 deleted products")).toBeInTheDocument();
    expect(screen.getAllByText("Deleted", { exact: true })).toHaveLength(2);
    expect(screen.getByText("BPC 5 / Vial")).toBeInTheDocument();
    expect(screen.getByText(`Deleted ${formatted(PRODUCTS[1].deletedAt)}`)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Restore Product" })).toHaveLength(2);
    // No user: no `by` text for that row.
    const row = screen.getByText("TB 500").closest(".min-h-14") as HTMLElement;
    expect(within(row).queryByText(/^by /)).toBeNull();
  });

  it("one deleted product: `1 deleted product`", async () => {
    listed = [PRODUCTS[0]];
    renderList();
    expect(await screen.findByText("1 deleted product")).toBeInTheDocument();
  });

  it("none: `No deleted products` and its sentence", async () => {
    listed = [];
    renderList();
    expect(await screen.findByText("No deleted products")).toBeInTheDocument();
    expect(screen.getByText("Products that are soft-deleted will appear here and can be restored.")).toBeInTheDocument();
  });
});

describe("F2-10 — Restore still restores", () => {
  it("POSTs the restore with the CSRF header, says so, and re-reads the list; `Restoring...` while it runs", async () => {
    renderList();
    await screen.findByText("BPC 5 Vial");
    holdRestore = () => {};
    fireEvent.click(screen.getAllByRole("button", { name: "Restore Product" })[0]);

    const restoring = await screen.findByRole("button", { name: "Restoring..." });
    expect(restoring).toBeDisabled();
    const post = fetchMock.mock.calls.find(([u]) => String(u) === "/api/admin/products/5/restore")!;
    expect(post[1]).toEqual(expect.objectContaining({ method: "POST", headers: { "x-csrf-token": "csrf-t" } }));

    listed = [PRODUCTS[1]];
    await act(async () => {
      holdRestore!();
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('"BPC 5 Vial" has been restored'));
    await waitFor(() => expect(screen.queryByText("BPC 5 Vial")).toBeNull());
    expect(screen.getByText("1 deleted product")).toBeInTheDocument();
  });

  it("a refused restore says the server's error", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    restoreOk = false;
    renderList();
    await screen.findByText("BPC 5 Vial");
    fireEvent.click(screen.getAllByRole("button", { name: "Restore Product" })[0]);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Nope"));
    (console.error as jest.Mock).mockRestore();
  });
});
