/** @jest-environment jsdom */
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

jest.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockLink = React.forwardRef<HTMLAnchorElement, any>(({ children, href, ...r }, ref) => (
    <a ref={ref} href={typeof href === "string" ? href : "#"} {...r}>
      {children}
    </a>
  ));
  MockLink.displayName = "NextLinkMock";
  return { __esModule: true, default: MockLink };
});
// Capture dialog props to assert the narrowed contract:
const dialogProps: Record<string, unknown[]> = { adjust: [], stockIn: [], transfer: [] };
jest.mock("@/components/inventory/quick-adjust-dialog", () => ({
  QuickAdjustDialog: (p: never) => {
    dialogProps.adjust.push(p);
    return null;
  },
}));
jest.mock("@/components/inventory/stock-in-dialog", () => ({
  StockInDialog: (p: never) => {
    dialogProps.stockIn.push(p);
    return null;
  },
}));
jest.mock("@/components/inventory/transfer-dialog", () => ({
  TransferDialog: (p: never) => {
    dialogProps.transfer.push(p);
    return null;
  },
}));

import InventoryPage from "@/app/(app)/inventory/page";

const variantsPage = (page: number, totalPages: number) => ({
  products: [
    {
      id: page,
      name: `P${page}`,
      baseName: `Cat${page}`,
      variant: null,
      combinedMinimum: 0,
      locations: [{ locationId: 1, locationName: "Main", quantity: 1, minQuantity: 0 }],
      totalQuantity: 1,
    },
  ],
  pagination: { page, pageSize: 12, total: totalPages * 12, totalPages, hasMore: page < totalPages },
});

function mockFetch(opts?: { failVariants?: boolean }) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/inventory/variants")) {
      if (opts?.failVariants)
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
      const page = Number(new URL(u, "http://x").searchParams.get("page") || 1);
      return { ok: true, json: async () => variantsPage(page, 10) } as Response;
    }
    if (u.includes("/api/inventory/logs"))
      return { ok: true, json: async () => ({ logs: [] }) } as Response;
    if (u.includes("/api/inventory/transfers"))
      return { ok: true, json: async () => ({ transfers: [] }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InventoryPage />
    </QueryClientProvider>
  );
};

beforeEach(() => {
  dialogProps.adjust = [];
  dialogProps.stockIn = [];
  dialogProps.transfer = [];
  window.localStorage.clear();
});

test("renders grouped categories; Adjustments tab is gone; Load more absent below cap", async () => {
  mockFetch();
  wrap();
  // "Cat1" appears in both the accordion trigger and the (hidden) card; target the trigger.
  expect(await screen.findByRole("button", { name: /Cat1/ })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /adjustments/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /load more/i })).toBeNull(); // observer stubbed -> pagesLoaded stays 1 < cap
});

test("variants error renders inline error + Retry, NOT the empty state", async () => {
  mockFetch({ failVariants: true });
  wrap();
  await waitFor(() => expect(screen.getByText(/could not load inventory/i)).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/no products found/i)).toBeNull();
});

test("dialogs receive EXACTLY {id, name} as product", async () => {
  mockFetch();
  wrap();
  const trigger = await screen.findByRole("button", { name: /Cat1/ });
  fireEvent.click(trigger); // expand accordion
  const stockInBtn = await screen.findByRole("button", { name: /stock in/i });
  fireEvent.click(stockInBtn);
  await waitFor(() => expect(dialogProps.stockIn.length).toBeGreaterThan(0));
  const last = dialogProps.stockIn[dialogProps.stockIn.length - 1] as { product?: unknown };
  expect(last.product).toEqual({ id: 1, name: "P1" });
});

// § P2-B3-1R (R-b.2 / M-a.3): the ADJUST dialog is mounted PER OPEN — rendered
// only while it is open for a product, and the product nulled when it closes —
// so every open is a fresh mount with an empty draft. (The Stock In and
// Transfer mounts are M-b1's.)
test("the adjust dialog is not rendered while closed, mounts per open, and its close nulls the product", async () => {
  mockFetch();
  wrap();
  const trigger = await screen.findByRole("button", { name: /Cat1/ });
  fireEvent.click(trigger); // expand accordion
  const adjustBtn = await screen.findByRole("button", { name: /^adjust$/i });

  // Closed: never rendered, not even with open=false.
  expect(dialogProps.adjust).toHaveLength(0);

  fireEvent.click(adjustBtn);
  await waitFor(() => expect(dialogProps.adjust.length).toBeGreaterThan(0));
  type AdjustProps = { open: boolean; product: unknown; onOpenChange: (open: boolean) => void };
  const first = dialogProps.adjust[dialogProps.adjust.length - 1] as AdjustProps;
  expect(first.open).toBe(true);
  expect(first.product).toEqual({ id: 1, name: "P1" });

  // The probe bites: while the product is set, a page re-render renders the
  // dialogs that hang off it (Stock In, closed) again.
  const stockInBefore = dialogProps.stockIn.length;
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(dialogProps.stockIn.length).toBeGreaterThan(stockInBefore);

  // Its close: unmounted, and the product nulled — so a page re-render renders
  // neither the adjust dialog nor anything else that hangs off the product.
  act(() => first.onOpenChange(false));
  const adjustRendersAfterClose = dialogProps.adjust.length;
  const stockInRendersAfterClose = dialogProps.stockIn.length;
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(dialogProps.adjust.length).toBe(adjustRendersAfterClose);
  expect(dialogProps.stockIn.length).toBe(stockInRendersAfterClose);

  // Reopen: rendered again for the product.
  fireEvent.click(await screen.findByRole("button", { name: /^adjust$/i }));
  await waitFor(() => expect(dialogProps.adjust.length).toBeGreaterThan(adjustRendersAfterClose));
  const second = dialogProps.adjust[dialogProps.adjust.length - 1] as AdjustProps;
  expect(second.open).toBe(true);
  expect(second.product).toEqual({ id: 1, name: "P1" });
});

test("another dialog's product does not mount the adjust dialog (closed is never rendered)", async () => {
  mockFetch();
  wrap();
  fireEvent.click(await screen.findByRole("button", { name: /Cat1/ }));
  fireEvent.click(await screen.findByRole("button", { name: /stock in/i }));
  await waitFor(() => expect(dialogProps.stockIn.length).toBeGreaterThan(0));
  // The product is set for Stock In; the adjust dialog is still not rendered,
  // so its next open is a fresh mount, never one carried over from this one.
  expect(dialogProps.adjust).toHaveLength(0);
});
