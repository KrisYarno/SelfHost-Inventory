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
// Capture dialog props to assert the narrowed contract — and count MOUNTS
// (§ P2-B3-1R, MS-1-5): a mocked dialog's mount effect runs once per mount, so
// the counter says whether an open was a fresh mount or a carried-over one.
const dialogProps: Record<string, unknown[]> = { adjust: [], stockIn: [], transfer: [] };
const dialogMounts: Record<string, number> = { adjust: 0, stockIn: 0, transfer: 0 };
function mockDialog(which: "adjust" | "stockIn" | "transfer") {
  return function MockDialog(p: never) {
    dialogProps[which].push(p);
    React.useEffect(() => {
      dialogMounts[which] += 1;
    }, []);
    return null;
  };
}
jest.mock("@/components/inventory/quick-adjust-dialog", () => ({
  QuickAdjustDialog: mockDialog("adjust"),
}));
jest.mock("@/components/inventory/stock-in-dialog", () => ({
  StockInDialog: mockDialog("stockIn"),
}));
jest.mock("@/components/inventory/transfer-dialog", () => ({
  TransferDialog: mockDialog("transfer"),
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
  dialogMounts.adjust = 0;
  dialogMounts.stockIn = 0;
  dialogMounts.transfer = 0;
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

// § P2-B3-1R (R-b.2 / M-a.3, and M-b1's MS-1-5 for Stock In and Transfer):
// every dialog on the page is mounted PER OPEN — rendered only while it is open
// for a product, with ONE shared product and three flags — and ANY close nulls
// the product. So every open is a fresh mount with an empty draft: nothing typed
// for product A can reach product B's adjustment, stock-in or transfer.
type DialogKey = "adjust" | "stockIn" | "transfer";
type DialogProps = { open: boolean; product: unknown; onOpenChange: (open: boolean) => void };
const BUTTON: Record<DialogKey, RegExp> = {
  adjust: /^adjust$/i,
  stockIn: /stock in/i,
  transfer: /transfer/i,
};
const lastProps = (which: DialogKey) =>
  dialogProps[which][dialogProps[which].length - 1] as DialogProps;

describe.each<DialogKey>(["adjust", "stockIn", "transfer"])("the %s dialog is mounted per open", (which) => {
  async function expandCategory() {
    const trigger = await screen.findByRole("button", { name: /Cat1/ });
    fireEvent.click(trigger); // expand accordion
    return trigger;
  }

  it("is not rendered while closed, mounts once per open, and every close nulls the product", async () => {
    mockFetch();
    wrap();
    const trigger = await expandCategory();
    const open = () => fireEvent.click(screen.getByRole("button", { name: BUTTON[which] }));
    await screen.findByRole("button", { name: BUTTON[which] });

    // Closed: never rendered, not even with open=false.
    expect(dialogProps[which]).toHaveLength(0);
    expect(dialogMounts[which]).toBe(0);

    // Open #1: one mount, for the product.
    open();
    await waitFor(() => expect(dialogMounts[which]).toBe(1));
    const first = lastProps(which);
    expect(first.open).toBe(true);
    expect(first.product).toEqual({ id: 1, name: "P1" });

    // A page re-render while it is open re-renders it — and does NOT remount it.
    const rendersBefore = dialogProps[which].length;
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(dialogProps[which].length).toBeGreaterThan(rendersBefore);
    expect(dialogMounts[which]).toBe(1);

    // Its close: unmounted, so a page re-render renders nothing…
    act(() => first.onOpenChange(false));
    const rendersAfterClose = dialogProps[which].length;
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(dialogProps[which].length).toBe(rendersAfterClose);

    // …and the PRODUCT is null: re-raising the flag through the stale callback
    // (open, but no subject) renders nothing, because the subject is gone.
    act(() => first.onOpenChange(true));
    expect(dialogProps[which].length).toBe(rendersAfterClose);
    expect(dialogMounts[which]).toBe(1);
    act(() => first.onOpenChange(false));

    // Open #2: a FRESH mount — the counter moves, never a carried-over instance.
    fireEvent.click(await screen.findByRole("button", { name: BUTTON[which] }));
    await waitFor(() => expect(dialogMounts[which]).toBe(2));
    const second = lastProps(which);
    expect(second.open).toBe(true);
    expect(second.product).toEqual({ id: 1, name: "P1" });
  });

  it("opening it never renders the other two (closed is never rendered)", async () => {
    mockFetch();
    wrap();
    await expandCategory();
    fireEvent.click(await screen.findByRole("button", { name: BUTTON[which] }));
    await waitFor(() => expect(dialogMounts[which]).toBe(1));

    for (const other of (["adjust", "stockIn", "transfer"] as DialogKey[]).filter((k) => k !== which)) {
      expect(dialogProps[other]).toHaveLength(0);
      expect(dialogMounts[other]).toBe(0);
    }
  });
});
