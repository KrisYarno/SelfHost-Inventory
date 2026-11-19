/** @jest-environment jsdom */
//
// Facelift FR1-1 (plan 2026-11-18-facelift-f1, REV 6; GR-1 = OCR-1, GR-3) —
// WRITERS ONLY EVER SEE A CONFIRMED LOCATION. Critical-grade: the selected
// location is where every stock write lands.
//
// Before: a saved location id restored from localStorage was handed to every
// writer BEFORE the list confirmed it. While `/api/locations` was loading, or
// after its first read failed (a 429 on the shared 30/min bucket, say), Stock
// In, Quick Adjust, the Journal and the workbench's Complete all wrote to that
// saved id — and no screen named it (the Journal's tag even read "Select a
// location" while Submit posted the id).
//
// Now the context publishes only an id a successful read has in the list. These
// pins run each writer under the REAL `LocationProvider`, with a saved key and a
// HELD or REFUSED `/api/locations`: each refuses and sends no write. Once the
// read succeeds with the saved id in the list, each writes to it.

import * as React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSession = {
  data: { user: { id: "u-1", name: "Kris", defaultLocationId: null } },
  status: "authenticated",
};
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
}));
jest.mock("sonner", () => {
  const toast = jest.fn() as jest.Mock & Record<string, jest.Mock>;
  toast.error = jest.fn();
  toast.success = jest.fn();
  toast.info = jest.fn();
  toast.warning = jest.fn();
  toast.message = jest.fn();
  toast.dismiss = jest.fn();
  return { toast };
});

import { toast } from "sonner";
import { LocationProvider, useLocation } from "@/contexts/location-context";
import { StockInDialog } from "@/components/inventory/stock-in-dialog";
import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";
import { CompleteOrderDialog } from "@/components/workbench/complete-order-dialog";
import JournalPage from "@/app/(app)/journal/page";
import { useWorkbench } from "@/hooks/use-workbench";
import { useJournalStore } from "@/hooks/use-journal";
import { RECEIVING_PROMPT_SESSION_KEY } from "@/components/inventory/receiving-redirect-prompt";
import type { ProductWithQuantity } from "@/types/product";

const KEY = "selectedLocationId";
const OFFICE = { id: 2, name: "Office" };
const LIST = [{ id: 1, name: "Main" }, OFFICE];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** How `/api/locations` answers its FIRST read: held until released, or refused. */
type FirstRead = "held" | "refused";
let firstRead: FirstRead;
let releaseHeld: (() => void) | null;
let fetchMock: jest.Mock;

/** The context as a consumer sees it (to Retry a refused read). */
let ctx: ReturnType<typeof useLocation> | null;
function Probe() {
  ctx = useLocation();
  return null;
}

/** Every request to a stock-WRITE route this test has sent. */
const WRITE_ROUTES = [
  "/api/inventory/stock-in",
  "/api/inventory/adjust",
  "/api/inventory/batch-adjust",
  "/api/inventory/deduct-simple",
  "/api/orders/",
];
const writes = () =>
  fetchMock.mock.calls.filter(([u, init]) => {
    const url = String(u);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    return method !== "GET" && WRITE_ROUTES.some((r) => url.startsWith(r));
  });
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  ctx = null;
  releaseHeld = null;
  window.localStorage.clear();
  window.localStorage.setItem(KEY, "2");
  window.sessionStorage.clear();
  window.sessionStorage.setItem(RECEIVING_PROMPT_SESSION_KEY, "1");
  act(() => {
    useWorkbench.getState().clearOrder();
  });
  useJournalStore.getState().clearAllAdjustments();
  jest.spyOn(console, "error").mockImplementation(() => {});

  let locationReads = 0;
  fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/api/locations") {
      locationReads += 1;
      if (locationReads === 1 && firstRead === "held") {
        return new Promise<Response>((resolve) => {
          releaseHeld = () => resolve(ok(LIST));
        });
      }
      if (locationReads === 1 && firstRead === "refused") {
        return { ok: false, status: 429, json: async () => ({ error: "Too many requests" }) } as unknown as Response;
      }
      return ok(LIST);
    }
    // Stock In / Quick Adjust: the current-stock read.
    if (/^\/api\/inventory\/product\/\d+\?/.test(url)) return ok({ currentQuantity: 40 });
    // The Journal's product rows.
    if (url.startsWith("/api/products")) {
      return ok({ products: [{ id: 1, name: "Widget A", baseName: null, variant: null, unit: "EA", numericValue: null, lowStockThreshold: 5, deletedAt: null, approvalStatus: "APPROVED" }] });
    }
    if (url.startsWith("/api/inventory/current-fast")) {
      return ok({ inventory: [{ productId: 1, quantity: 10, version: 3 }] });
    }
    if (url.startsWith("/api/settings/low-stock-default")) return ok({ threshold: 10 });
    if (url === "/api/inventory/stock-in") return ok({ success: true });
    if (url === "/api/inventory/adjust") {
      return ok({ success: true, log: { id: 1, orderRecordId: null }, newVersion: 2, batchId: "b-1" });
    }
    if (url === "/api/inventory/batch-adjust") return ok({ logs: [{ id: 1 }] });
    if (url === "/api/inventory/deduct-simple") {
      return ok({ success: true, batchId: "b-1", results: [{ productId: 501, quantity: 2 }] });
    }
    return ok({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // A held read never left pending against a discarded tree.
  releaseHeld?.();
  jest.restoreAllMocks();
});

function renderUnderProvider(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <LocationProvider>
      <QueryClientProvider client={qc}>
        <Probe />
        {ui}
      </QueryClientProvider>
    </LocationProvider>
  );
}

/** The first read is out (held) or has answered (refused); the saved key is "2". */
async function settleFirstRead() {
  await act(async () => {});
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/locations")).toBe(true));
  if (firstRead === "refused") await waitFor(() => expect(ctx?.loadFailed).toBe(true));
  else expect(ctx?.isLoading).toBe(true);
  // The premise: a saved id, and no writer told about it.
  expect(window.localStorage.getItem(KEY)).toBe("2");
  expect(ctx?.selectedLocationId).toBeNull();
}

/** The read succeeds with the saved id in the list: released, or a Retry. */
async function confirmLocation() {
  if (firstRead === "held") {
    await act(async () => {
      releaseHeld!();
      releaseHeld = null;
    });
  } else {
    await act(async () => {
      ctx!.retryLocations();
    });
  }
  await waitFor(() => expect(ctx?.selectedLocationId).toBe(2));
}

/** The ladder sentence a writer shows while the read is held or refused. */
const ladder = () => (firstRead === "held" ? "Loading locations…" : "Couldn't load locations.");

/** Calls a button's own React onClick, as any path past `disabled` would. */
async function pressPastDisabled(button: HTMLElement) {
  const node = button as unknown as Record<string, unknown>;
  const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  const props = node[propsKey!] as { onClick: (e: { preventDefault: () => void }) => unknown };
  await act(async () => {
    await props.onClick({ preventDefault: () => {} });
  });
}

describe.each<[string, FirstRead]>([
  ["the first `/api/locations` read is HELD (loading)", "held"],
  ["the first `/api/locations` read is REFUSED (a 429)", "refused"],
])("FR1-1 — a saved location id while %s", (_label, mode) => {
  beforeEach(() => {
    firstRead = mode;
  });

  it("Stock In refuses and sends nothing; once the read confirms the id, it writes there", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderUnderProvider(
      <StockInDialog open onOpenChange={jest.fn()} product={{ id: 42, name: "AOD 2mg" }} onSuccess={jest.fn()} />
    );
    await settleFirstRead();
    expect(screen.getByText("No location selected.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/quantity to add/i), "3");
    await user.click(screen.getByRole("button", { name: /^Add 3 Units$/ }));
    expect(toast.error).toHaveBeenCalledWith("No location selected");
    expect(writes()).toHaveLength(0);

    await confirmLocation();
    await user.click(screen.getByRole("button", { name: /^Add 3 Units$/ }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(String(writes()[0][0])).toBe("/api/inventory/stock-in");
    expect(bodyOf(writes()[0])).toMatchObject({ productId: 42, locationId: 2, quantity: 3 });
  });

  it("Quick Adjust refuses — its blocker names the ladder rung, the action is dead, the handler sends nothing; once confirmed, it writes there", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderUnderProvider(
      <QuickAdjustDialog open onOpenChange={jest.fn()} product={{ id: 42, name: "AOD 2mg" }} onSuccess={jest.fn()} />
    );
    await settleFirstRead();

    await user.type(screen.getByLabelText(/^Units to remove$/), "3");
    expect(screen.getByTestId("adjust-message")).toHaveTextContent(ladder());
    const action = () => within(screen.getByTestId("adjust-footer")).getAllByRole("button")[1];
    expect(action()).toBeDisabled();
    await pressPastDisabled(action());
    expect(writes()).toHaveLength(0);

    await confirmLocation();
    await waitFor(() => expect(screen.getByTestId("adjust-stock")).toHaveTextContent("40 units"));
    expect(action()).toBeEnabled();
    await user.click(action());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(String(writes()[0][0])).toBe("/api/inventory/adjust");
    expect(bodyOf(writes()[0])).toMatchObject({ productId: 42, locationId: 2, delta: -3 });
  });

  it("the Journal's tag names the ladder rung (never a bare `Select a location`) and Submit sends nothing; once confirmed, it writes there", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    useJournalStore.getState().addAdjustment({ productId: 1, quantityChange: 5, version: 3 });
    renderUnderProvider(<JournalPage />);
    await settleFirstRead();

    // The TAG (the header's): FR2-2's products list now says the rung too.
    const header = screen.getByRole("heading", { level: 1, name: "Inventory Journal" }).closest("header") as HTMLElement;
    expect(within(header).getByText(ladder())).toBeInTheDocument();
    expect(screen.queryByText("Select a location")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Review & Submit/ }));
    await user.click(screen.getByRole("button", { name: /confirm and submit adjustments/i }));
    expect(toast.error).toHaveBeenCalledWith("No location selected");
    expect(writes()).toHaveLength(0);

    await confirmLocation();
    await waitFor(() => expect(screen.getByText("Office")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Widget A").length).toBeGreaterThan(0));
    // The refused submit left the review open; Confirm again.
    await user.click(screen.getByRole("button", { name: /confirm and submit adjustments/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(String(writes()[0][0])).toBe("/api/inventory/batch-adjust");
    expect((bodyOf(writes()[0]).adjustments as Array<Record<string, unknown>>)[0]).toMatchObject({
      productId: 1,
      locationId: 2,
      delta: 5,
    });
  });

  it("the workbench's Complete refuses and sends nothing; once confirmed, it deducts there", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const ROW = { id: 501, name: "Widget In Stock", currentQuantity: 10 } as unknown as ProductWithQuantity;
    act(() => {
      useWorkbench.getState().addItem(ROW, 2, "manual");
      useWorkbench.getState().setOrderReference("M-1");
    });
    renderUnderProvider(<CompleteOrderDialog open onOpenChange={jest.fn()} onSuccess={jest.fn()} />);
    await settleFirstRead();

    await user.click(screen.getByRole("button", { name: "Complete Order" }));
    expect(toast.error).toHaveBeenCalledWith("Please select a location");
    expect(writes()).toHaveLength(0);

    await confirmLocation();
    await user.click(screen.getByRole("button", { name: "Complete Order" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(String(writes()[0][0])).toBe("/api/inventory/deduct-simple");
    expect(bodyOf(writes()[0])).toMatchObject({ orderReference: "M-1", locationId: 2 });
  });
});

// Facelift FR2-2 (REV 8, FD1-2) — THE JOURNAL'S PRODUCTS LIST NEVER SAYS "EMPTY"
// WITHOUT A READ. With no confirmed location (FR1-1) the products hook has no
// location to read for and answers nothing at once, and the list said
// `No products found` — while the locations read was still loading, after it
// failed, and after a stale id was discarded. Now its first branch says why
// there is no list: the same ladder the tag uses, ending in
// `Choose a location to see products.`
describe("FR2-2 — the Journal's products list with no confirmed location", () => {
  const productsList = () => screen.getByRole("region", { name: "Products" });
  /** The list's one status line (the rows have their own; none are on screen here). */
  const listStatus = () => within(productsList()).getByRole("status");

  describe.each<[string, FirstRead]>([
    ["the first `/api/locations` read is HELD (loading)", "held"],
    ["the first `/api/locations` read is REFUSED (a 429)", "refused"],
  ])("a saved id while %s", (_label, mode) => {
    beforeEach(() => {
      firstRead = mode;
    });

    it("the list says the ladder rung, never `No products found`; once the read confirms the id, the rows", async () => {
      renderUnderProvider(<JournalPage />);
      await settleFirstRead();
      await act(async () => {});

      expect(listStatus().textContent).toBe(ladder());
      expect(listStatus()).toHaveAttribute("aria-live", "polite");
      expect(within(productsList()).queryByText("No products found")).toBeNull();

      await confirmLocation();
      await waitFor(() => expect(within(productsList()).getAllByText("Widget A").length).toBeGreaterThan(0));
      expect(within(productsList()).queryByText(ladder())).toBeNull();
      expect(within(productsList()).queryByText("No products found")).toBeNull();
    });
  });

  it("a stale saved id, discarded: `Choose a location to see products.` — never `No products found`", async () => {
    // The first read answers WITHOUT the saved id (2): the rules discard it.
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: unknown) =>
      String(input) === "/api/locations" ? ok([{ id: 1, name: "Main" }]) : answer(input)
    );
    renderUnderProvider(<JournalPage />);
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith("Your saved location is no longer available. Choose a location.")
    );
    await act(async () => {});
    expect(ctx?.isLoading).toBe(false);
    expect(ctx?.selectedLocationId).toBeNull();

    expect(listStatus().textContent).toBe("Choose a location to see products.");
    expect(within(productsList()).queryByText("No products found")).toBeNull();
  });
});
