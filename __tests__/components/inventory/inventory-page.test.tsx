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

// Facelift F1-6 (plan 2026-11-18-facelift-f1 REV 2): Inventory renders through
// the `Page` frame — wide (today's full width, now with a gutter) — with its
// unchanged title as the framed h1 and its header buttons, classes kept, as the
// actions. The phone-only Refresh (an icon) is labelled.
test("F1-6 — renders through Page (wide); the header buttons are the actions; the phone Refresh is labelled", async () => {
  mockFetch();
  wrap();
  const h1 = await screen.findByRole("heading", { level: 1, name: "Inventory Management" });
  expect(h1.getAttribute("class")).toBe("text-h2 sm:text-h1 min-w-0");
  const header = h1.closest("header") as HTMLElement;
  expect((header.parentElement as HTMLElement).getAttribute("class")).toBe(
    "px-4 sm:px-6 py-4 mx-auto max-w-none"
  );
  const refresh = screen.getByRole("button", { name: "Refresh" });
  expect(refresh).toHaveAttribute("aria-label", "Refresh");
  expect(refresh).toHaveClass("sm:hidden");
  expect(header).toContainElement(refresh);
  const journal = screen.getByRole("link", { name: /journal/i });
  expect(header).toContainElement(journal);
  expect(journal).toHaveClass("flex-1", "sm:flex-initial");
  const exportButton = screen.getByRole("button", { name: /export/i });
  expect(header).toContainElement(exportButton);
  expect(exportButton).toHaveClass("flex-1", "sm:flex-initial");
});

// Facelift FR1-8 (REV 6, OCR-9): `Could not load inventory.` replaced the list
// on ANY error — a failed refresh over loaded rows wiped them from the screen.
// It renders only when the read failed with nothing loaded.
describe("FR1-8 — the inventory list's failure state, beside QueryState's rule", () => {
  test("a failed REFRESH keeps the rows: no failure sentence over loaded data", async () => {
    let failVariants = false;
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory/variants")) {
        if (failVariants) return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
        const page = Number(new URL(u, "http://x").searchParams.get("page") || 1);
        return { ok: true, json: async () => variantsPage(page, 10) } as Response;
      }
      return { ok: true, json: async () => ({ logs: [], transfers: [] }) } as Response;
    }) as unknown as typeof fetch;
    wrap();
    expect(await screen.findByRole("button", { name: /Cat1/ })).toBeInTheDocument();
    const variantReads = () =>
      (global.fetch as jest.Mock).mock.calls.filter(([u]) => String(u).includes("/api/inventory/variants")).length;
    const before = variantReads();

    failVariants = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(variantReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    await act(async () => {});

    expect(screen.queryByText("Could not load inventory.")).toBeNull();
    expect(screen.getByRole("button", { name: /Cat1/ })).toBeInTheDocument();
  });

  test("a failed FIRST read (nothing loaded) still says so, with Retry (unchanged)", async () => {
    mockFetch({ failVariants: true });
    wrap();
    expect(await screen.findByText("Could not load inventory.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

// Facelift FR2-1 (REV 8, FD1-1): a failed NEXT page stops auto-load and says so.
//
// Before: the sentinel's observer is recreated on every render (the page's
// inline `onLoadMore`), and a real observer reports its target once on
// `observe()`. FR1-8 keeps the rows — and so the sentinel — mounted after a
// failed page, so every render after the failure made a fresh observer that saw
// the sentinel in view and asked for the page again: a failing page 2 read in
// a loop, and the screen never said anything. Now the auto-load gate is closed
// while the last next-page read failed; the sentinel says `Couldn't load more
// inventory.` with a Retry.
describe("FR2-1 — a failed next page stops auto-load and says so", () => {
  /**
   * A controllable IntersectionObserver: like a real one, it reports each
   * target's state ONCE, asynchronously, after `observe()` — and never for a
   * target it no longer observes. `inView` is whether the sentinel is on screen.
   */
  class ControlledIntersectionObserver {
    static inView = true;
    private targets = new Set<Element>();
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target);
      setTimeout(() => {
        if (!this.targets.has(target)) return;
        act(() => {
          this.callback(
            [{ isIntersecting: ControlledIntersectionObserver.inView, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          );
        });
      }, 0);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
    takeRecords() {
      return [];
    }
  }

  const originalObserver = global.IntersectionObserver;
  beforeEach(() => {
    ControlledIntersectionObserver.inView = true;
    global.IntersectionObserver = ControlledIntersectionObserver as unknown as typeof IntersectionObserver;
  });
  afterEach(() => {
    global.IntersectionObserver = originalObserver;
  });

  /** Page 2 fails until `page2Ok` is set; every other page answers. */
  let page2Ok: boolean;
  function mockPages() {
    page2Ok = false;
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory/variants")) {
        const page = Number(new URL(u, "http://x").searchParams.get("page") || 1);
        if (page === 2 && !page2Ok) return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
        return { ok: true, json: async () => variantsPage(page, 10) } as Response;
      }
      return { ok: true, json: async () => ({ logs: [], transfers: [] }) } as Response;
    }) as unknown as typeof fetch;
  }
  const pageReads = (page: number) =>
    (global.fetch as jest.Mock).mock.calls.filter(([u]) => {
      const url = String(u);
      return url.includes("/api/inventory/variants") && new URL(url, "http://x").searchParams.get("page") === String(page);
    }).length;
  /** Lets a few observer rounds (each a timer) and their renders run. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

  const FAILED = "Couldn't load more inventory.";

  it("a failed page 2 issues exactly ONE read, then the sentence and Retry — and no further reads while it stays in view", async () => {
    mockPages();
    wrap();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    const sentence = screen.getByText(FAILED);
    expect(sentence.tagName).toBe("P");
    expect(sentence).toHaveClass("text-sm", "text-destructive");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(sentence.parentElement).toContainElement(retry);
    expect(pageReads(2)).toBe(1);

    // The sentinel stays in view, and every re-render makes a fresh observer
    // that reports it: still no read.
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /Cat1/ }));
      await settle();
    }
    expect(pageReads(2)).toBe(1);
    // The rows stay; a failed NEXT page is not a failed list.
    expect(screen.getByRole("button", { name: /Cat1/ })).toBeInTheDocument();
    expect(screen.queryByText("Could not load inventory.")).toBeNull();
  });

  it("Retry issues ONE read; on success the sentence goes and auto-load resumes", async () => {
    mockPages();
    wrap();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(pageReads(2)).toBe(1);
    expect(pageReads(3)).toBe(0);

    page2Ok = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(FAILED)).toBeNull());
    expect(pageReads(2)).toBe(2);
    // Auto-load resumed: page 3 is read by the sentinel, once — and then the
    // page limit (3) hands over to Load more.
    await waitFor(() => expect(pageReads(3)).toBe(1));
    expect(await screen.findByRole("button", { name: /load more/i })).toBeInTheDocument();
    await settle();
    expect(pageReads(2)).toBe(2);
    expect(pageReads(3)).toBe(1);
    expect(pageReads(4)).toBe(0);
  });

  // Facelift FR3-1 (REV 11, FD2-1): auto-load waits for ANY in-flight read.
  //
  // Before: the gate waited only for a NEXT-page read. An invalidation (every
  // write on the page, and Refresh) refetches the loaded pages, and that
  // refetch overwrites the failed next page's direction — so mid-refetch the
  // gate read open, the sentinel's observer asked for page 2, and
  // `fetchNextPage` CANCELLED the refetch (react-query's `cancelRefetch`
  // default): page 1's new stock never landed, and page 2 was read again.
  describe("FR3-1 — auto-load waits for ANY in-flight read", () => {
    let page1Qty: number;
    let holdPage1: boolean;
    let releasePage1: (() => void) | null;
    function mockHeldPages() {
      page2Ok = false;
      page1Qty = 1;
      holdPage1 = false;
      releasePage1 = null;
      global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/api/inventory/variants")) {
          const page = Number(new URL(u, "http://x").searchParams.get("page") || 1);
          if (page === 2 && !page2Ok) return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
          const body = variantsPage(page, 10);
          if (page === 1) {
            body.products[0].totalQuantity = page1Qty;
            body.products[0].locations[0].quantity = page1Qty;
            if (holdPage1) await new Promise<void>((resolve) => (releasePage1 = resolve));
          }
          return { ok: true, json: async () => body } as Response;
        }
        return { ok: true, json: async () => ({ logs: [], transfers: [] }) } as Response;
      }) as unknown as typeof fetch;
    }
    afterEach(() => {
      releasePage1?.();
    });

    it("a failed page 2, then a refetch-all HELD on page 1: no next-page read while it is held; on release page 1's new stock shows, then exactly one page-2 read", async () => {
      mockHeldPages();
      wrap();
      expect(await screen.findByText(FAILED)).toBeInTheDocument();
      expect(pageReads(1)).toBe(1);
      expect(pageReads(2)).toBe(1);
      expect(screen.getByRole("button", { name: /Cat1/ })).toHaveTextContent("1 units");

      // A write elsewhere: the server now holds 7, and the page-1 read is slow.
      page1Qty = 7;
      holdPage1 = true;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(pageReads(1)).toBe(2));

      // Held: the sentinel stays in view, and every render's fresh observer
      // reports it — and no next-page read is issued.
      for (let i = 0; i < 4; i++) {
        fireEvent.click(screen.getByRole("button", { name: /Cat1/ }));
        await settle();
      }
      expect(pageReads(2)).toBe(1);
      expect(releasePage1).not.toBeNull();

      // Released: page 1's new quantity shows…
      await act(async () => {
        releasePage1!();
        releasePage1 = null;
      });
      await waitFor(() => expect(screen.getByRole("button", { name: /Cat1/ })).toHaveTextContent("7 units"));
      // …then exactly ONE page-2 read follows (it fails again, and the gate holds).
      await waitFor(() => expect(pageReads(2)).toBe(2));
      expect(await screen.findByText(FAILED)).toBeInTheDocument();
      for (let i = 0; i < 3; i++) await settle();
      expect(pageReads(1)).toBe(2);
      expect(pageReads(2)).toBe(2);
    });
  });
});
