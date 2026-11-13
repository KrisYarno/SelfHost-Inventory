/** @jest-environment jsdom */
//
// W0.5-a (contract pack REV-2, T6) — the complete-order dialog's per-CLASS,
// per-line acknowledgement checklist.
//
// The dialog had no harness, so this file builds one. Two deliberate choices:
//
//   1. The WC order is seeded through the REAL zustand store
//      (`useWorkbench.getState().selectExternalOrder`), not by hand-writing
//      `unmappedExternalItems`. The three classes the as-built array mixes
//      (truly unmapped / mapped-but-not-in-the-loaded-products / bundle) are
//      therefore produced by the real hook (hooks/use-workbench.ts:205-259),
//      so these pins cover the hook -> dialog seam, not just the renderer.
//   2. Everything else the dialog reaches for is mocked at the module edge
//      (CSRF, location context, router, sonner) following the house idiom in
//      __tests__/components/inventory/quick-adjust-dialog.test.tsx.
//
// The behaviour under contract: tap-required lines block Complete until each is
// individually acknowledged; bundles never require a tap; reopening the dialog
// resets the taps; nothing is ever sent on decline.

import * as React from "react";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false, error: null, refreshToken: jest.fn() }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "test-csrf" }),
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ selectedLocationId: 1, locations: [{ id: 1, name: "Main" }] }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), message: jest.fn() },
}));

import { toast } from "sonner";
import { CompleteOrderDialog } from "@/components/workbench/complete-order-dialog";
import {
  CAP_COUNTER_FROM,
  MAX_FULFILLMENT_ITEMS,
  MAX_SIMPLE_DEDUCT_ITEMS,
} from "@/lib/inventory/request-limits";
import { useWorkbench } from "@/hooks/use-workbench";
import type { ExternalOrder } from "@/types/external-orders";
import type { ProductWithQuantity } from "@/types/product";

// ---------------------------------------------------------------------------
// Contract copy (T6) — asserted verbatim, per class
// ---------------------------------------------------------------------------

const COPY_UNMAPPED = "ships unmapped — not deducted";
const COPY_UNAVAILABLE = "mapped but unavailable — not deducted";
const COPY_BUNDLE = "bundle — fulfill via Order Details";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

const orderItem = (over: Partial<ExternalItem>): ExternalItem => ({
  id: "it-0",
  orderId: "ord-1",
  externalItemId: null,
  externalProductId: "wc-p-000",
  externalVariantId: null,
  name: "Item",
  variantName: null,
  sku: null,
  quantity: 1,
  fulfilledQty: 0,
  price: 10,
  productLinkId: null,
  isMapped: false,
  ...over,
});

// Maps to a loaded product -> lands in the cart (never in the checklist).
const CART_ITEM = orderItem({
  id: "it-cart",
  name: "Widget In Stock",
  quantity: 2,
  isMapped: true,
  productLinkId: "pl-1",
  productLink: {
    id: "pl-1",
    internalProductId: 501,
    externalSku: null,
    externalTitle: null,
    internalProduct: { id: 501, name: "Widget In Stock", baseName: null, variant: null },
  },
});

// A SECOND cart line (F29): the all-or-nothing gate compares SUMS, so two
// fractional entries can add up to exactly what the cart asked for and sail
// through it. The Undo body's own filter is what has to catch them.
const CART_ITEM_2 = orderItem({
  id: "it-cart-2",
  name: "Widget Also In Stock",
  quantity: 3,
  isMapped: true,
  productLinkId: "pl-4",
  productLink: {
    id: "pl-4",
    internalProductId: 503,
    externalSku: null,
    externalTitle: null,
    internalProduct: { id: 503, name: "Widget Also In Stock", baseName: null, variant: null },
  },
});

// Mapped, but the link is a BUNDLE -> class 3, no tap.
const BUNDLE_ITEM = orderItem({
  id: "it-bundle",
  name: "Starter Bundle",
  quantity: 1,
  isMapped: true,
  productLinkId: "pl-2",
  productLink: {
    id: "pl-2",
    internalProductId: 502,
    externalSku: null,
    externalTitle: null,
    isBundle: true,
    internalProduct: { id: 502, name: "Starter Bundle", baseName: null, variant: null },
  },
});

// Mapped, but internalProductId 900 is NOT in the loaded products -> class 2.
const UNAVAILABLE_ITEM = orderItem({
  id: "it-ghost",
  name: "Ghost Vial",
  quantity: 3,
  isMapped: true,
  productLinkId: "pl-3",
  productLink: {
    id: "pl-3",
    internalProductId: 900,
    externalSku: null,
    externalTitle: null,
    internalProduct: { id: 900, name: "Ghost Vial", baseName: null, variant: null },
  },
});

// Never mapped -> class 1.
const UNMAPPED_ITEM_A = orderItem({
  id: "it-unmapped-a",
  name: "Mystery Peptide",
  sku: "MP-1",
  quantity: 4,
  externalProductId: "wc-p-777",
});
const UNMAPPED_ITEM_B = orderItem({
  id: "it-unmapped-b",
  name: "Second Mystery",
  quantity: 1,
  externalProductId: "wc-p-888",
});

const makeOrder = (items: ExternalItem[]): ExternalOrder => ({
  id: "ord-1",
  companyId: "co-1",
  integrationId: "int-1",
  externalId: "9001",
  orderNumber: "9001",
  nativeStatus: "processing",
  financialStatus: null,
  fulfillmentStatus: null,
  platformStatusRaw: null,
  externalStatusHash: null,
  externalOrderUrl: null,
  total: 123.45,
  currency: "USD",
  customerEmail: null,
  customerName: "Ada L",
  rawPayload: null,
  internalStatus: "processing",
  fulfilledAt: null,
  fulfilledBy: null,
  stockedOut: false,
  stockedOutAt: null,
  stockedOutBy: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  externalCreatedAt: null,
  externalUpdatedAt: null,
  lastSeenAt: null,
  items,
});

// ProductWithQuantity extends the full Prisma Product row; the store only reads
// id / name / currentQuantity, so the fixture casts at this seam.
const LOADED_PRODUCTS = [
  { id: 501, name: "Widget In Stock", currentQuantity: 10 },
  { id: 503, name: "Widget Also In Stock", currentQuantity: 10 },
] as unknown as ProductWithQuantity[];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn(
    async () => ({ ok: true, json: async () => ({ success: true }) } as unknown as Response)
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  act(() => {
    useWorkbench.getState().clearOrder();
  });
});

function seedOrder(items: ExternalItem[]) {
  act(() => {
    useWorkbench.getState().selectExternalOrder(makeOrder(items), LOADED_PRODUCTS);
  });
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = jest.fn();
  const onSuccess = jest.fn();
  const ui = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <CompleteOrderDialog open={open} onOpenChange={onOpenChange} onSuccess={onSuccess} />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  // QA-6b: the client is handed back so a pin can watch what a refusal path
  // invalidates — the real `invalidateInventoryCaches` still runs.
  return {
    onOpenChange,
    onSuccess,
    queryClient,
    setOpen: (open: boolean) => view.rerender(ui(open)),
  };
}

const completeButton = () => screen.getByRole("button", { name: "Complete & Fulfill" });
const tapTargets = () => screen.queryAllByRole("checkbox");

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

describe("complete-order dialog — per-class skipped-line checklist (T6)", () => {
  it("renders each of the three classes with its own truthful copy", () => {
    seedOrder([CART_ITEM, BUNDLE_ITEM, UNAVAILABLE_ITEM, UNMAPPED_ITEM_A, UNMAPPED_ITEM_B]);
    renderDialog();

    expect(screen.getAllByText(COPY_UNMAPPED)).toHaveLength(2);
    expect(screen.getAllByText(COPY_UNAVAILABLE)).toHaveLength(1);
    expect(screen.getAllByText(COPY_BUNDLE)).toHaveLength(1);

    // The cart line is never part of the checklist.
    expect(screen.queryByRole("checkbox", { name: /Widget In Stock/ })).toBeNull();
    // The bundle line is listed but is NOT a tap target.
    expect(screen.queryByRole("checkbox", { name: /Starter Bundle/ })).toBeNull();
  });

  it("requires one tap per tap-required line, with bundles excluded from the count", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_ITEM, BUNDLE_ITEM, UNAVAILABLE_ITEM, UNMAPPED_ITEM_A, UNMAPPED_ITEM_B]);
    renderDialog();

    // 2 unmapped + 1 unavailable = 3; the bundle does not count.
    expect(tapTargets()).toHaveLength(3);
    expect(completeButton()).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /Mystery Peptide/ }));
    expect(screen.getByRole("checkbox", { name: /Mystery Peptide/ })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    // Acknowledgement is per line, not global.
    expect(screen.getByRole("checkbox", { name: /Ghost Vial/ })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(completeButton()).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /Second Mystery/ }));
    expect(completeButton()).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /Ghost Vial/ }));
    expect(completeButton()).toBeEnabled();
  });

  it("requires no taps when every skipped line is a bundle", () => {
    seedOrder([CART_ITEM, BUNDLE_ITEM]);
    renderDialog();

    expect(screen.getAllByText(COPY_BUNDLE)).toHaveLength(1);
    expect(tapTargets()).toHaveLength(0);
    expect(completeButton()).toBeEnabled();
  });

  it("leaves the flow unchanged when there are no skipped lines at all", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_ITEM]);
    renderDialog();

    expect(tapTargets()).toHaveLength(0);
    expect(screen.queryByText(/will not be deducted/i)).toBeNull();
    expect(completeButton()).toBeEnabled();

    await user.click(completeButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/orders/ord-1/fulfill");
  });

  it("never blocks completion once every tap-required line is acknowledged", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_ITEM, BUNDLE_ITEM, UNAVAILABLE_ITEM, UNMAPPED_ITEM_A]);
    renderDialog();

    expect(tapTargets()).toHaveLength(2);
    for (const target of tapTargets()) {
      await user.click(target);
    }
    expect(completeButton()).toBeEnabled();

    await user.click(completeButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/orders/ord-1/fulfill");
  });

  it("resets the taps when the dialog is reopened (intended friction)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_ITEM, UNAVAILABLE_ITEM, UNMAPPED_ITEM_A]);
    const { setOpen } = renderDialog();

    for (const target of tapTargets()) {
      await user.click(target);
    }
    expect(completeButton()).toBeEnabled();

    act(() => setOpen(false));
    act(() => setOpen(true));

    expect(tapTargets()).toHaveLength(2);
    for (const target of tapTargets()) {
      expect(target).toHaveAttribute("aria-checked", "false");
    }
    expect(completeButton()).toBeDisabled();
  });

  // QA-13 (LOW, latent). The checklist renders under `isWCOrder &&
  // skippedLines.length > 0`, but the gate on Complete was derived from
  // `unmappedExternalItems` UNGATED. Today every store path clears the two
  // together, so the states cannot diverge — which is exactly what makes this
  // the kind of bug that ships: the first store edit that leaves unmapped lines
  // behind without a selected order disables Complete forever, with no checklist
  // on screen to explain why and no way to acknowledge anything.
  it("QA-13: a non-WC order completes even with unmapped lines left in the store", () => {
    seedOrder([CART_ITEM, UNAVAILABLE_ITEM, UNMAPPED_ITEM_A]);
    // The divergence, forced: the order is gone, its unmapped lines are not.
    act(() => {
      useWorkbench.setState({ selectedExternalOrder: null });
    });
    renderDialog();

    // Nothing to acknowledge is rendered, because the checklist is WC-only...
    expect(tapTargets()).toHaveLength(0);
    expect(screen.queryByText(/will not be deducted/i)).toBeNull();

    // ...so nothing may be held back on the strength of it.
    expect(screen.getByRole("button", { name: "Complete Order" })).toBeEnabled();
  });

  it("sends nothing when the operator declines with lines still unacknowledged", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_ITEM, UNAVAILABLE_ITEM, UNMAPPED_ITEM_A]);
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// THE BATCH-ID THREAD (reconciliation Part 2, pack CB1b.6 / seam S-B5)
//
// A completion is one operator action and up to TWO movements: the WC lines go
// through fulfill, the manual lines through deduct-simple, each minting its own
// batch. The Undo that follows has to be able to name what it is reversing, so
// the pair travels on the completion envelope — read off the responses, never
// inferred, and `null` for a leg that did not run.
// ---------------------------------------------------------------------------

describe("complete-order dialog — the completion names the batches it wrote", () => {
  /** Answer each leg with the batch id its route would have minted. */
  function respondWithBatches(fulfilBatchId: string | null, deductBatchId: string | null) {
    fetchMock.mockImplementation(async (url: unknown) => {
      const href = String(url);
      const batchId = href.includes("/fulfill") ? fulfilBatchId : deductBatchId;
      return {
        ok: true,
        json: async () => ({ success: true, ...(batchId ? { batchId } : {}) }),
      } as unknown as Response;
    });
  }

  it("a MIXED cart carries BOTH ids, each from its own leg's response", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respondWithBatches("fulfil-batch-1", "deduct-batch-1");
    seedOrder([CART_ITEM]);
    // ...plus a manual line, which is what makes this cart mixed.
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0].batchIds).toEqual({
      fulfilBatchId: "fulfil-batch-1",
      deductSimpleBatchId: "deduct-batch-1",
    });
    // Both legs ran, in the house order: fulfil first, then the manual deduct.
    expect(String(fetchMock.mock.calls[0][0])).toContain("/fulfill");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/inventory/deduct-simple");
  });

  // -------------------------------------------------------------------------
  // THE UNDO'S WC BODY (reconciliation Part 2, pack CB2b.3 / seam S-B17).
  //
  // `fulfilledForUndo` is built from `results.fulfilled` and from NOTHING else.
  // The cart is what was ASKED for; the envelope is what MOVED. A body built
  // from the cart restores units out of another operator's fulfilment, which is
  // the one class of guess this seam exists to make impossible.
  // -------------------------------------------------------------------------

  it("fulfilledForUndo is built from results.fulfilled — the SERVER's ids, not the cart's", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockImplementation(async (url: unknown) => ({
      ok: true,
      json: async () =>
        String(url).includes("/fulfill")
          ? {
              success: true,
              batchId: "fulfil-batch-1",
              // The cart's line maps to product 501; the SERVER says it deducted
              // 999. The Undo has to put the units back where they came FROM.
              results: { fulfilled: [{ itemId: "it-cart", productId: 999, quantity: 2 }] },
              summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
            }
          : { success: true, batchId: "deduct-batch-1" },
    } as unknown as Response));
    seedOrder([CART_ITEM]);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0].fulfilledForUndo).toEqual([
      { itemId: "it-cart", productId: 999, quantity: 2, locationId: 1 },
    ]);
  });

  it("an entry the envelope did not fully name is OMITTED, with a warning — never completed from the cart", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: unknown) => ({
      ok: true,
      json: async () =>
        String(url).includes("/fulfill")
          ? {
              success: true,
              batchId: "fulfil-batch-1",
              results: { fulfilled: [{ itemId: "it-cart", productId: 501 }] },
              summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
            }
          : { success: true, batchId: "deduct-batch-1" },
    } as unknown as Response));
    seedOrder([CART_ITEM]);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0].fulfilledForUndo).toEqual([]);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("it-cart"));
    consoleWarn.mockRestore();
  });

  // F29: `UnfulfillItemSchema` requires `z.number().int()` on BOTH numbers. A
  // fractional quantity would be posted straight into a 400 this page provoked —
  // and silently: the operator would be told the undo failed without ever being
  // told which line the server could not name. Malformed is malformed, so it is
  // omitted and named like every other one.
  it("a FRACTIONAL quantity is omitted and NAMED — the schema wants an integer", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    // 2.5 + 2.5 = the 5 units this cart asked for, so the all-or-nothing gate —
    // which compares SUMS — sees nothing wrong and the completion stands. The
    // Undo body is where the fractions have to be caught.
    fetchMock.mockImplementation(async (url: unknown) => ({
      ok: true,
      json: async () =>
        String(url).includes("/fulfill")
          ? {
              success: true,
              batchId: "fulfil-batch-1",
              results: {
                fulfilled: [
                  { itemId: "it-cart", productId: 501, quantity: 2.5 },
                  { itemId: "it-cart-2", productId: 503, quantity: 2.5 },
                ],
              },
              summary: { total: 2, fulfilled: 2, skipped: 0, failed: 0 },
            }
          : { success: true, batchId: "deduct-batch-1" },
    } as unknown as Response));
    seedOrder([CART_ITEM, CART_ITEM_2]);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0].fulfilledForUndo).toEqual([]);
    const warned = consoleWarn.mock.calls.map((call) => String(call[0]));
    expect(warned.some((line) => line.includes("it-cart"))).toBe(true);
    expect(warned.some((line) => line.includes("it-cart-2"))).toBe(true);
    consoleWarn.mockRestore();
  });

  it("a FRACTIONAL productId is omitted too — it names no row", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: unknown) => ({
      ok: true,
      json: async () =>
        String(url).includes("/fulfill")
          ? {
              success: true,
              batchId: "fulfil-batch-1",
              results: { fulfilled: [{ itemId: "it-cart", productId: 501.5, quantity: 2 }] },
              summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
            }
          : { success: true, batchId: "deduct-batch-1" },
    } as unknown as Response));
    seedOrder([CART_ITEM]);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0].fulfilledForUndo).toEqual([]);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("it-cart"));
    consoleWarn.mockRestore();
  });

  it("a MANUAL-ONLY cart carries fulfilledForUndo: [] — the key EXISTS", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respondWithBatches(null, "deduct-batch-3");
    act(() => {
      useWorkbench.getState().setOrderReference("manual-ref");
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Complete Order" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0].fulfilledForUndo).toEqual([]);
  });

  it("a MANUAL-ONLY cart carries fulfilBatchId: null — never undefined", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respondWithBatches(null, "deduct-batch-2");
    act(() => {
      useWorkbench.getState().setOrderReference("manual-ref");
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Complete Order" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    const { batchIds } = onSuccess.mock.calls[0][0];
    expect(batchIds).toEqual({ fulfilBatchId: null, deductSimpleBatchId: "deduct-batch-2" });
    // The key EXISTS and is null: "this cart had no WC leg" is a fact the Undo
    // reads, not an absence it has to guess at.
    expect(Object.keys(batchIds).sort()).toEqual(["deductSimpleBatchId", "fulfilBatchId"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // THE REFUSAL COPY (reconciliation Part 2, pack REV-22 F7 / OCb-6).
  //
  // Both of this dialog's error readers only understood the NESTED body shape
  // (`{ error: { message, code } }`), while `apiHandler` — which every B1 route
  // answers through — emits the FLAT one. So a named refusal (`ORDER_GONE`,
  // `INSUFFICIENT_STOCK`, `TOO_MANY_KEYS`) arrived as "Failed to fulfill WC
  // order" with its code dropped on the floor. One shared reader now reads both.
  // -------------------------------------------------------------------------
  describe("complete-order dialog — a refusal says what the server said", () => {
    /** Render the JSX sonner was handed and return the screen it produced. */
    function renderToastBody() {
      const body = (toast.error as jest.Mock).mock.calls[0][0] as React.ReactElement;
      render(<>{body}</>);
    }

    it("says the ORDER_GONE copy, not a generic fulfil failure", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      (toast.error as jest.Mock).mockClear();
      fetchMock.mockImplementation(async () => ({
        ok: false,
        status: 409,
        // Flat: exactly what `apiHandler` sends for the order lock's refusal.
        json: async () => ({ error: "order ord-1 no longer exists", code: "ORDER_GONE" }),
      } as unknown as Response));
      seedOrder([CART_ITEM]);
      const { onSuccess } = renderDialog();

      await user.click(completeButton());
      await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

      renderToastBody();
      expect(
        screen.getByText("this order no longer exists — refresh and re-check")
      ).toBeInTheDocument();
      // Nothing was completed, so nothing is announced as completed.
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("says the INSUFFICIENT_STOCK sentence verbatim on the manual leg", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      (toast.error as jest.Mock).mockClear();
      fetchMock.mockImplementation(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: "Product 777: Insufficient inventory: current 0, trying to remove 1",
          code: "INSUFFICIENT_STOCK",
        }),
      } as unknown as Response));
      act(() => {
        useWorkbench.getState().setOrderReference("manual-ref");
        useWorkbench
          .getState()
          .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
      });
      renderDialog();

      await user.click(screen.getByRole("button", { name: "Complete Order" }));
      await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

      renderToastBody();
      expect(
        screen.getByText("Product 777: Insufficient inventory: current 0, trying to remove 1")
      ).toBeInTheDocument();
    });
  });

  it("a response with NO batchId threads null rather than undefined", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // The pre-B1b wire shape, in case an older server answers a newer client.
    respondWithBatches(null, null);
    act(() => {
      useWorkbench.getState().setOrderReference("manual-ref");
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Complete Order" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0].batchIds).toEqual({
      fulfilBatchId: null,
      deductSimpleBatchId: null,
    });
  });
});

// ---------------------------------------------------------------------------
// THE ENVELOPE, READ (reconciliation Part 2, pack CB1.5c / seam S-B15).
//
// This surface used to test `response.ok` and nothing else: it set
// wcFulfilled = true, ran the manual leg, and then reported every cart item as
// deducted. From B1.5 a fulfil can answer 200 having refused some or all of the
// lines (a short line is a `skipped` entry), so a 200 is an ANSWER, not a
// success — and the WC leg here is all-or-nothing by its documented P0-2
// posture: a partial fulfilment is put back and the completion stops.
//
// The rollback is built from `results.fulfilled` — the lines the SERVER says it
// deducted — never from the cart, and a 2xx that restored nothing is not a
// rollback.
// ---------------------------------------------------------------------------

describe("complete-order dialog — a 200 that refused lines is a refusal", () => {
  // The sonner mock is module-level and the file's own beforeEach does not
  // touch it, so each pin starts from a clean toast log — a leaked call from an
  // earlier test would read as this test's copy.
  beforeEach(() => {
    (toast.error as jest.Mock).mockClear();
    (toast.warning as jest.Mock).mockClear();
    (toast.success as jest.Mock).mockClear();
  });

  /** N mapped WC lines the store will put straight into the cart. */
  function wcOrderOf(count: number, quantity = 1) {
    const products = Array.from({ length: count }, (_, idx) => ({
      id: 600 + idx,
      name: `Line ${idx}`,
      currentQuantity: 10,
    })) as unknown as ProductWithQuantity[];
    const items = Array.from({ length: count }, (_, idx) =>
      orderItem({
        id: `it-${idx}`,
        name: `Line ${idx}`,
        quantity,
        isMapped: true,
        productLinkId: `pl-${idx}`,
        productLink: {
          id: `pl-${idx}`,
          internalProductId: 600 + idx,
          externalSku: null,
          externalTitle: null,
          internalProduct: {
            id: 600 + idx,
            name: `Line ${idx}`,
            baseName: null,
            variant: null,
          },
        },
      })
    );
    return { items, products };
  }

  function seedWcCart(count: number, quantity = 1) {
    const { items, products } = wcOrderOf(count, quantity);
    act(() => {
      useWorkbench.getState().selectExternalOrder(makeOrder(items), products);
    });
  }

  /** Route each leg's response by URL. */
  function respond(handlers: {
    fulfill?: () => Partial<Response> & { json: () => Promise<unknown> };
    unfulfill?: () => Partial<Response> & { json: () => Promise<unknown> };
    deduct?: () => Partial<Response> & { json: () => Promise<unknown> };
  }) {
    fetchMock.mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/unfulfill")) {
        return (handlers.unfulfill?.() ?? {
          ok: true,
          json: async () => ({ restored: [] }),
        }) as unknown as Response;
      }
      if (href.includes("/fulfill")) {
        return (handlers.fulfill?.() ?? {
          ok: true,
          json: async () => ({ success: true }),
        }) as unknown as Response;
      }
      return (handlers.deduct?.() ?? {
        ok: true,
        json: async () => ({ success: true }),
      }) as unknown as Response;
    });
  }

  const calls = (fragment: string) =>
    fetchMock.mock.calls.filter((call) => String(call[0]).includes(fragment));

  const bodyOf = (call: unknown[]) =>
    JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

  /** Render every toast body sonner was handed, and return the combined text. */
  function toastText(fn: jest.Mock): string {
    return fn.mock.calls
      .map((call) => {
        const { container } = render(<>{call[0] as React.ReactElement}</>);
        return container.textContent ?? "";
      })
      .join(" | ");
  }

  it("NOTHING fulfilled: no manual leg, no rollback, and the coded refusal copy", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: null,
          summary: { total: 2, fulfilled: 0, skipped: 2, failed: 0 },
          results: {
            fulfilled: [],
            skipped: [
              { itemId: "it-0", reason: "unmapped", details: "Item is not mapped" },
              {
                itemId: "it-1",
                reason: "insufficient_stock",
                details: "Insufficient stock for Line 1. Available: 0, Requested: 1",
              },
            ],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(2);
    // ...plus a manual line, whose whole point here is that it never ships.
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    // The fulfil was the ONLY request: nothing was deducted, so there is
    // nothing to put back and no second movement to make.
    expect(calls("/api/inventory/deduct-simple")).toHaveLength(0);
    expect(calls("/unfulfill")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Nothing was deducted");
    // The refusal is chosen by PRIORITY: the short line, not the pass-1 skip
    // that precedes it in the array.
    expect(text).toContain("Insufficient stock for Line 1. Available: 0, Requested: 1");
    // G2s-2: nothing was fulfilled, so no rollback ran — the action must not
    // claim one. `FULFILMENT_NOT_STARTED` copy, not `FULFILMENT_REFUSED`'s.
    expect(text).toContain("Nothing was sent to WooCommerce. Fix the issue and try again.");
    expect(text).not.toContain("were put back");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("1 of 2 fulfilled: ONE unfulfill naming ONLY the fulfilled entry, and no manual leg", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-9",
          summary: { total: 2, fulfilled: 1, skipped: 1, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600, quantity: 1, productName: "Line 0" }],
            skipped: [
              {
                itemId: "it-1",
                reason: "insufficient_stock",
                details: "Insufficient stock for Line 1. Available: 0, Requested: 1",
              },
            ],
            failed: [],
          },
        }),
      }),
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [{ itemId: "it-0" }] }) }),
    });
    seedWcCart(2);
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const rollbacks = calls("/unfulfill");
    expect(rollbacks).toHaveLength(1);
    // ONLY the line the server said it deducted — the refused sibling is not
    // credited stock it never lost.
    expect(bodyOf(rollbacks[0]).items).toEqual([
      { itemId: "it-0", productId: 600, quantity: 1, locationId: 1 },
    ]);
    expect(calls("/api/inventory/deduct-simple")).toHaveLength(0);

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Nothing was deducted");
    expect(text).toContain("Insufficient stock for Line 1. Available: 0, Requested: 1");
    // G2s-2, the OTHER branch: a rollback DID run and fully restored, so this
    // copy — and only this copy — may promise the lines came back.
    expect(text).toContain("Any fulfilled WooCommerce lines were put back. Fix the issue and try again.");
    expect(text).not.toContain("Nothing was sent to WooCommerce");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("a rollback that restored NOTHING throws UNCODED, so no toast claims the lines came back", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-9",
          summary: { total: 2, fulfilled: 1, skipped: 1, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600, quantity: 1 }],
            skipped: [
              {
                itemId: "it-1",
                reason: "insufficient_stock",
                details: "Insufficient stock for Line 1. Available: 0, Requested: 1",
              },
            ],
            failed: [],
          },
        }),
      }),
      // A 2xx that restored nothing is NOT a rollback (QB-4).
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [] }) }),
    });
    seedWcCart(2);
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect((toast.error as jest.Mock).mock.calls.length).toBeGreaterThan(1));

    const text = toastText(toast.error as jest.Mock);
    // The incident toast tells the truth...
    expect(text).toContain("Rollback failed");
    expect(text).toContain("restored only 0 of 1 lines");
    // ...and the second toast does NOT contradict it. This is the one path
    // where the data really is inconsistent, so the coded copy is withheld.
    expect(text).not.toContain("Nothing was deducted");
    expect(text).not.toContain("were put back");
    expect(text).toContain("Something went wrong");
  });

  it("a manual-leg failure after a FULL WC leg rolls back THE SERVER'S entries, by item id", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-3",
          summary: { total: 2, fulfilled: 2, skipped: 0, failed: 0 },
          results: {
            // Deliberately NOT in cart order, and the second entry carries no
            // productId: the rollback must match it by `fulfillmentItemId`
            // (DCc-11), never by position — a positional fallback here would
            // credit product 601 the stock that came off product 600.
            fulfilled: [
              { itemId: "it-1", productId: 601, quantity: 1 },
              { itemId: "it-0", quantity: 1 },
            ],
            skipped: [],
            failed: [],
          },
        }),
      }),
      deduct: () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: "Product 777: Insufficient inventory: current 0, trying to remove 1",
          code: "INSUFFICIENT_STOCK",
        }),
      }),
      unfulfill: () => ({
        ok: true,
        json: async () => ({ restored: [{ itemId: "it-1" }, { itemId: "it-0" }] }),
      }),
    });
    seedWcCart(2);
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const rollbacks = calls("/unfulfill");
    expect(rollbacks).toHaveLength(1);
    // The FULFILLED entries, in the server's own order — not the cart.
    expect(bodyOf(rollbacks[0]).items).toEqual([
      { itemId: "it-1", productId: 601, quantity: 1, locationId: 1 },
      { itemId: "it-0", productId: 600, quantity: 1, locationId: 1 },
    ]);
    // restored.length === the entries sent, so the rollback stands and the
    // incident toast is NOT raised.
    expect(toastText(toast.error as jest.Mock)).not.toContain("Rollback failed");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("a manual-leg failure whose rollback restores NOTHING raises the incident toast", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-4",
          summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600, quantity: 1 }],
            skipped: [],
            failed: [],
          },
        }),
      }),
      deduct: () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "Failed to process order", code: "INSUFFICIENT_STOCK" }),
      }),
      // A 2xx carrying `restored: []` — accepted as a successful rollback
      // before B1.5c, which is how a WC leg could stay deducted with the
      // operator told only that the manual leg failed.
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [] }) }),
    });
    seedWcCart(1);
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Rollback failed");
    expect(text).toContain("restored only 0 of 1 lines");
  });

  it("QA-3: a manual-leg failure with NO entries owes the SUMMARY's count, never '0 of 0'", async () => {
    // The tolerated skew (FD1-3): the summary counts a line `results.fulfilled`
    // does not name, so the leg passes the all-or-nothing gate and the manual
    // leg runs. When THAT fails, the rollback has no entries to send — and the
    // incident toast used to tell the operator it "restored only 0 of 0 lines",
    // a sentence that reads as "nothing was owed". The gate site already passes
    // the hint; this is the second call site.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-7",
          summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
          // The skew: counted, but not named.
          results: { fulfilled: [], skipped: [], failed: [] },
        }),
      }),
      deduct: () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "Failed to process order", code: "INSUFFICIENT_STOCK" }),
      }),
    });
    seedWcCart(1);
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { queryClient } = renderDialog();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Rollback failed");
    expect(text).toContain("restored only 0 of 1 lines");
    expect(text).not.toContain("0 of 0");
    // Nothing was sendable, so no unfulfill request was made at all.
    expect(calls("/unfulfill")).toHaveLength(0);
    // FQ-2a: the DEDUCT-site QA-6b invalidation has its own net — stock moved
    // (the WC leg deducted; nothing came back), so the caches must go stale.
    const invalidatedRoots = invalidateSpy.mock.calls
      .map((call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0])
      .filter((root): root is string => typeof root === "string");
    expect(invalidatedRoots).toContain("products");
  });

  it("QA-6b: a refusal that rolled back still refreshes the inventory caches", async () => {
    // Stock genuinely MOVED on this path (a line was deducted, then credited
    // back), and the completion throws instead of reaching the success block
    // that invalidates. /inventory kept its pre-fulfil numbers until the next
    // manual refresh — the operator reads a page the server disagrees with.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-8",
          summary: { total: 2, fulfilled: 1, skipped: 1, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600, quantity: 1 }],
            skipped: [
              {
                itemId: "it-1",
                reason: "insufficient_stock",
                details: "Insufficient stock for Line 1. Available: 0, Requested: 1",
              },
            ],
            failed: [],
          },
        }),
      }),
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [{ itemId: "it-0" }] }) }),
    });
    seedWcCart(2);
    const { queryClient } = renderDialog();
    const invalidateQueries = jest.spyOn(queryClient, "invalidateQueries");

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const keys = invalidateQueries.mock.calls.map(
      (call) => (call[0] as { queryKey?: unknown } | undefined)?.queryKey
    );
    expect(keys).toContainEqual(["inventory-products"]);
    expect(keys).toContainEqual(["dashboard-metrics"]);
  });

  it("a 503 BUSY from the fulfil leg names itself as busy (OCc-20)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: false,
        status: 503,
        // The ladder's whole-request answer (B1.5 behaviour change 1).
        json: async () => ({
          error: "the system was busy with another change — try again",
          code: "BUSY",
        }),
      }),
    });
    seedWcCart(1);
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("The system was busy");
    expect(text).toContain("the system was busy with another change — try again");
    expect(text).toContain("Try again in a moment.");
  });

  // -------------------------------------------------------------------------
  // THE CLAMP (OC-1). `lib/fulfillment.ts` fulfils `min(asked, remaining)`, so a
  // line can come back FULFILLED at a shorter quantity — counted by the line
  // gate, invisible to it. The Undo that follows restores by QUANTITY against
  // the line's total `fulfilledQty`, so a cart-quantity Undo after a clamped
  // fulfil takes units out of whatever another operator fulfilled.
  // -------------------------------------------------------------------------

  it("OC-1: a CLAMPED line is a refusal — the units are gated, not just the line count", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-c",
          // EVERY line "fulfilled" — the line count says the leg is whole...
          summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
          // ...and the entry says only 2 of the 5 asked units moved.
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600, quantity: 2 }],
            skipped: [],
            failed: [],
          },
        }),
      }),
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [{ itemId: "it-0" }] }) }),
    });
    seedWcCart(1, 5);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    // The leg is put back — the SERVER'S 2 units, not the cart's 5.
    const rollbacks = calls("/unfulfill");
    expect(rollbacks).toHaveLength(1);
    expect(bodyOf(rollbacks[0]).items).toEqual([
      { itemId: "it-0", productId: 600, quantity: 2, locationId: 1 },
    ]);
    // ...the completion stops, so nothing is announced and no Undo is armed.
    expect(calls("/api/inventory/deduct-simple")).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(toastText(toast.error as jest.Mock)).toContain("Nothing was deducted");
  });

  it("OC-1: a FULL leg's deduction details carry the SERVER'S quantities, by item id", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // A PROBE shape: the server's per-line numbers are deliberately not the
    // cart's (2/3 asked, 3/2 answered) while the SUM still matches, which is the
    // only way to see which of the two the Undo copies. A real clamp only ever
    // shortens — and is refused by the pin above.
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-f",
          summary: { total: 2, fulfilled: 2, skipped: 0, failed: 0 },
          results: {
            fulfilled: [
              { itemId: "it-0", productId: 600, quantity: 3 },
              { itemId: "it-1", productId: 601, quantity: 2 },
            ],
            skipped: [],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(2, 2);
    act(() => {
      useWorkbench.getState().updateItemQuantity(601, 3, "it-1");
    });
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    const details = onSuccess.mock.calls[0][0].items as Array<{
      fulfillmentItemId?: string;
      quantity: number;
    }>;
    const quantityFor = (itemId: string) =>
      details.find((detail) => detail.fulfillmentItemId === itemId)?.quantity;
    expect(quantityFor("it-0")).toBe(3);
    expect(quantityFor("it-1")).toBe(2);
  });

  it("OC-8: an already_fulfilled refusal names the way out of the retry loop", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: null,
          summary: { total: 1, fulfilled: 0, skipped: 1, failed: 0 },
          results: {
            fulfilled: [],
            skipped: [
              {
                itemId: "it-0",
                reason: "already_fulfilled",
                details: "Item is already fully fulfilled",
              },
            ],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(1);
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Item is already fully fulfilled");
    // Without this sentence "Fix the issue and try again" is a loop: the cart is
    // built once at selection, so every retry refuses the same way.
    expect(text).toContain("Re-select the order to rebuild the cart from its current state.");
  });

  it("G2s-4: an entry whose quantity cannot be resolved is skipped from the body and NAMED", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-q",
          summary: { total: 2, fulfilled: 1, skipped: 1, failed: 0 },
          results: {
            fulfilled: [
              { itemId: "it-0", productId: 600, quantity: 1 },
              // A good product id, no quantity, and no cart line to fall back
              // to: shipping this as `quantity: 0` 400s the WHOLE rollback body
              // on the schema's `positive()`, taking its resolvable sibling with it.
              { itemId: "it-ghost", productId: 601 },
            ],
            skipped: [{ itemId: "it-1", reason: "unmapped", details: "Item is not mapped" }],
            failed: [],
          },
        }),
      }),
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [{ itemId: "it-0" }] }) }),
    });
    seedWcCart(2);
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const rollbacks = calls("/unfulfill");
    expect(rollbacks).toHaveLength(1);
    expect(bodyOf(rollbacks[0]).items).toEqual([
      { itemId: "it-0", productId: 600, quantity: 1, locationId: 1 },
    ]);

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Not sent for restoration (no product id or quantity): it-ghost.");
  });

  it("G2s-5: a rollback that failed at a GUARD path still raises the critical toast", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-g",
          // The summary says a line moved; the envelope names NO entry to put
          // back. The zero-entries belt used to fail to the console alone.
          summary: { total: 2, fulfilled: 1, skipped: 1, failed: 0 },
          results: {
            fulfilled: [],
            skipped: [{ itemId: "it-1", reason: "unmapped", details: "Item is not mapped" }],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(2);
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    // Nothing could be sent, so no request was made — and the operator is told.
    expect(calls("/unfulfill")).toHaveLength(0);
    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Rollback failed");
    expect(text).toContain("Please check inventory manually for order ord-1.");
  });

  // -------------------------------------------------------------------------
  // THE SHAPE SKEWS (FD1-1..FD1-4, FD1-7). The gate reads TWO facts — the
  // summary's line count and the `results.fulfilled` entries' units — and a
  // skewed body can make them disagree. These pin which fact wins on each
  // asymmetry, and what the operator is told when it does.
  // -------------------------------------------------------------------------

  it("FD1-1: the units-only refusal names both numbers and the way out", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-u",
          // Every line "fulfilled", nothing skipped and nothing failed: the
          // envelope names no refusal at all, so the priority reader has
          // nothing to surface and the operator used to get the bare fallback.
          summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600, quantity: 2 }],
            skipped: [],
            failed: [],
          },
        }),
      }),
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [{ itemId: "it-0" }] }) }),
    });
    seedWcCart(1, 5);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const text = toastText(toast.error as jest.Mock);
    // BOTH numbers — what moved and what was asked — and the exit that exists.
    expect(text).toContain("The order had 2 of the 5 units this cart asked for.");
    expect(text).toContain("Re-select the order to rebuild the cart from its current state.");
    expect(text).not.toContain("the order could not be fulfilled");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("FD1-2: the Undo's productId is the SERVER'S when the entry names one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // A PROBE shape: the cart line's product is 600 and the server says it
    // deducted 977. Only one of the two can be what the Undo posts, and the
    // rollback body already prefers the server's — the Undo has to agree.
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-p",
          summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 977, quantity: 2 }],
            skipped: [],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(1, 2);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    const details = onSuccess.mock.calls[0][0].items as Array<{
      productId: number;
      fulfillmentItemId?: string;
    }>;
    expect(details.find((detail) => detail.fulfillmentItemId === "it-0")?.productId).toBe(977);
  });

  it("FD1-3: a FULL line count with NO entries is not a unit verdict", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-n",
          // The summary says the leg is whole; the envelope names no entries.
          // With no evidence there is no unit verdict to reach — summing an
          // absent array to 0 would refuse (and try to roll back) a leg that
          // moved exactly what was asked.
          summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
          results: { fulfilled: [], skipped: [], failed: [] },
        }),
      }),
    });
    seedWcCart(1, 2);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(calls("/unfulfill")).toHaveLength(0);
    expect(toast.error as jest.Mock).not.toHaveBeenCalled();
    // ...and with no entry to read, the Undo keeps the cart's number.
    const details = onSuccess.mock.calls[0][0].items as Array<{ quantity: number }>;
    expect(details[0].quantity).toBe(2);
  });

  it("FD1-3: a ZERO count with entries PRESENT rolls the entries back — evidence wins", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-z",
          // The summary contradicts its own evidence: 0 fulfilled, one entry
          // the server says it deducted. Believing the count leaves that line
          // deducted forever under copy claiming nothing was sent.
          summary: { total: 2, fulfilled: 0, skipped: 1, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600, quantity: 1 }],
            skipped: [{ itemId: "it-1", reason: "unmapped", details: "Item is not mapped" }],
            failed: [],
          },
        }),
      }),
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [{ itemId: "it-0" }] }) }),
    });
    seedWcCart(2);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const rollbacks = calls("/unfulfill");
    expect(rollbacks).toHaveLength(1);
    expect(bodyOf(rollbacks[0]).items).toEqual([
      { itemId: "it-0", productId: 600, quantity: 1, locationId: 1 },
    ]);

    const text = toastText(toast.error as jest.Mock);
    // The rollback ran and fully restored, so this is the REFUSED copy — never
    // the NOT_STARTED copy, which would claim nothing was ever sent.
    expect(text).toContain("Any fulfilled WooCommerce lines were put back. Fix the issue and try again.");
    expect(text).not.toContain("Nothing was sent to WooCommerce");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("FD1-4: the rollback never ships the CART'S number for an entry that lacks one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-m",
          summary: { total: 3, fulfilled: 2, skipped: 1, failed: 0 },
          results: {
            fulfilled: [
              { itemId: "it-0", productId: 600, quantity: 1 },
              // MATCHED to a cart line (it-1), but the entry names no quantity.
              // Substituting the cart's 1 restores units the server never says
              // it took — an over-restore out of another operator's fulfilment.
              { itemId: "it-1", productId: 601 },
            ],
            skipped: [{ itemId: "it-2", reason: "unmapped", details: "Item is not mapped" }],
            failed: [],
          },
        }),
      }),
      unfulfill: () => ({ ok: true, json: async () => ({ restored: [{ itemId: "it-0" }] }) }),
    });
    seedWcCart(3);
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const rollbacks = calls("/unfulfill");
    expect(rollbacks).toHaveLength(1);
    expect(bodyOf(rollbacks[0]).items).toEqual([
      { itemId: "it-0", productId: 600, quantity: 1, locationId: 1 },
    ]);

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Not sent for restoration (no product id or quantity): Line 1.");
  });

  it("FD1-7: the re-select sentence fires on a MIXED refusal set", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: null,
          summary: { total: 2, fulfilled: 0, skipped: 2, failed: 0 },
          results: {
            fulfilled: [],
            // The looping reason is SECOND: a `skipped[0]` read misses it, and
            // the retry it causes refuses identically every time.
            skipped: [
              { itemId: "it-0", reason: "unmapped", details: "Item is not mapped" },
              {
                itemId: "it-1",
                reason: "already_fulfilled",
                details: "Item is already fully fulfilled",
              },
            ],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(2);
    renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Item is not mapped");
    expect(text).toContain("Re-select the order to rebuild the cart from its current state.");
  });

  it("FD2-2: an entry with NO quantity is dropped from the Undo details, and named", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    // A FULL success by both halves of the gate: one line, one entry, and the
    // unit sum falls back to the cart's number so nothing is refused. The
    // entry still carries no quantity of its own — and the Undo posts these
    // numbers to unfulfill, which is the door FD1-4 closed on the rollback
    // body. Restoring the cart's number here would credit units the server
    // never said it took.
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: "fulfil-batch-q",
          summary: { total: 1, fulfilled: 1, skipped: 0, failed: 0 },
          results: {
            fulfilled: [{ itemId: "it-0", productId: 600 }],
            skipped: [],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(1, 2);
    // A manual line rides along: it has no entry to read and keeps the cart's
    // number, so this pin sees the WC line DROPPED, not the whole array lost.
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    const details = onSuccess.mock.calls[0][0].items as Array<{
      productId: number;
      quantity: number;
      fulfillmentItemId?: string;
    }>;
    expect(details.find((detail) => detail.fulfillmentItemId === "it-0")).toBeUndefined();
    expect(details).toEqual([
      expect.objectContaining({ productId: 777, quantity: 1, fulfillmentItemId: undefined }),
    ]);
    expect(warn.mock.calls.map((call) => call.join(" ")).join(" | ")).toContain("it-0");
    warn.mockRestore();
  });

  it("FD2-3: a NEGATIVE count with no entries never claims the lines were put back", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // A skewed body: the summary counts fewer than zero fulfilled lines and
    // names no entries. Nothing is rolled back — so the refusal must be the
    // NOT_STARTED one. `restoredFully` starting life as `true` used to make
    // this the REFUSED copy, which promises a rollback that never ran.
    respond({
      fulfill: () => ({
        ok: true,
        json: async () => ({
          success: true,
          batchId: null,
          summary: { total: 2, fulfilled: -1, skipped: 2, failed: 0 },
          results: {
            fulfilled: [],
            skipped: [
              {
                itemId: "it-1",
                reason: "insufficient_stock",
                details: "Insufficient stock for Line 1. Available: 0, Requested: 1",
              },
            ],
            failed: [],
          },
        }),
      }),
    });
    seedWcCart(2);
    const { onSuccess } = renderDialog();

    await user.click(completeButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    expect(calls("/unfulfill")).toHaveLength(0);
    const text = toastText(toast.error as jest.Mock);
    expect(text).toContain("Nothing was sent to WooCommerce. Fix the issue and try again.");
    expect(text).not.toContain("were put back");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // THE CAP GUARD (QB-3 / seam S-B10). Each leg counts against its own route's
  // cap, and the over-cap sentence renders at the `Total Items:` row — the one
  // row BOTH the WC and the non-WC paths render (OCc-7).
  // -------------------------------------------------------------------------

  const WC_OVER = `This order has ${MAX_FULFILLMENT_ITEMS + 1} WooCommerce lines; fulfilment handles at most ${MAX_FULFILLMENT_ITEMS} per request.`;
  const MANUAL_OVER = `This cart has ${MAX_SIMPLE_DEDUCT_ITEMS + 1} manual lines; deduction handles at most ${MAX_SIMPLE_DEDUCT_ITEMS} per request.`;

  it("no counter at 50 WC lines", () => {
    seedWcCart(50);
    renderDialog();

    expect(screen.queryByText(new RegExp(`of ${MAX_FULFILLMENT_ITEMS}$`))).toBeNull();
    expect(completeButton()).toBeEnabled();
  });

  it(`the WC counter appears above ${CAP_COUNTER_FROM}`, () => {
    seedWcCart(CAP_COUNTER_FROM + 1);
    renderDialog();

    expect(
      screen.getByText(`${CAP_COUNTER_FROM + 1} of ${MAX_FULFILLMENT_ITEMS}`)
    ).toBeInTheDocument();
    expect(screen.queryByText(WC_OVER)).toBeNull();
    expect(completeButton()).toBeEnabled();
  });

  it("at exactly the cap the confirm is still enabled", () => {
    seedWcCart(MAX_FULFILLMENT_ITEMS);
    renderDialog();

    expect(
      screen.getByText(`${MAX_FULFILLMENT_ITEMS} of ${MAX_FULFILLMENT_ITEMS}`)
    ).toBeInTheDocument();
    expect(completeButton()).toBeEnabled();
  });

  it("one WC line over the cap: Confirm is refused, with the sentence at the Total Items row", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedWcCart(MAX_FULFILLMENT_ITEMS + 1);
    renderDialog();

    const sentence = screen.getByText(WC_OVER);
    // AT the Total Items row (OCc-7): the summary card is the one block both
    // the WC and the non-WC paths render, which is what makes the refusal
    // visible to a cart that has no `From Order` header at all.
    expect(sentence.closest("div")?.textContent).toContain("Total Items:");
    expect(completeButton()).toBeDisabled();

    await user.click(completeButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 101-line NON-WC cart gets the same treatment — the row both paths render", () => {
    act(() => {
      useWorkbench.getState().setOrderReference("manual-ref");
      Array.from({ length: MAX_SIMPLE_DEDUCT_ITEMS + 1 }, (_, idx) => idx).forEach((idx) => {
        useWorkbench
          .getState()
          .addItem(
            { id: 800 + idx, name: `Manual ${idx}`, currentQuantity: 5 } as unknown as ProductWithQuantity,
            1
          );
      });
    });
    renderDialog();

    const sentence = screen.getByText(MANUAL_OVER);
    expect(sentence.closest("div")?.textContent).toContain("Total Items:");
    expect(screen.getByRole("button", { name: "Complete Order" })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// ONE COMPLETION PER TAP (§ P2-B3-1R, M-b1 fix 1 — MS-1-2).
//
// The action is a Radix close: with no `preventDefault` the dialog CLOSED on the
// tap, so "Processing..." and the frozen fields never rendered, and a second
// Complete on a manual cart sent a second deduct-simple POST — a double
// deduction. Now the keep-open idiom + the shared latch: the dialog stays up
// until the answer, a second tap sends nothing, and Escape / Cancel are dropped
// while the request is in flight. The harness renders with `open` FIXED, so the
// pins watch `onOpenChange` itself — the call a real host would close on.
// ---------------------------------------------------------------------------

describe("complete-order dialog — one completion per tap (MS-1-2)", () => {
  /** A deduct-simple answer the test releases by hand: the write "in flight". */
  function holdDeduct() {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/inventory/deduct-simple")) await answered;
      return {
        ok: true,
        json: async () => ({ success: true, batchId: "deduct-batch-held" }),
      } as unknown as Response;
    });
    return release;
  }

  const deductCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/inventory/deduct-simple"));

  /** A manual cart: the path where a second Complete was a second deduction. */
  function seedManualCart() {
    act(() => {
      useWorkbench.getState().setOrderReference("manual-ref");
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
  }

  const confirm = () =>
    screen.getByRole("button", { name: /^(Complete Order|Processing\.\.\.)$/ });

  it("onOpenChange is NOT called with false between the tap and the deduct-simple answer", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const release = holdDeduct();
    seedManualCart();
    const { onOpenChange, onSuccess } = renderDialog();

    await user.click(confirm());
    await waitFor(() => expect(deductCalls()).toHaveLength(1));
    // In flight: still open, and it says so.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(confirm()).toHaveTextContent("Processing...");
    expect(confirm()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    // The answer closes it — once, through the host's raw callback.
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it("a double tap sends ONE deduct-simple POST", async () => {
    const release = holdDeduct();
    seedManualCart();
    const { onSuccess } = renderDialog();

    // Both taps in the instant before "Processing..." renders (FD3-1): only the
    // latch's synchronous ref can refuse the second.
    act(() => {
      fireEvent.click(confirm());
      expect(confirm()).toHaveTextContent("Complete Order");
      fireEvent.click(confirm());
    });
    await waitFor(() => expect(deductCalls()).toHaveLength(1));

    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(deductCalls()).toHaveLength(1);
  });

  it("Escape while busy does not close it; the answer does", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const release = holdDeduct();
    seedManualCart();
    const { onOpenChange, onSuccess } = renderDialog();

    await user.click(confirm());
    await waitFor(() => expect(confirm()).toHaveTextContent("Processing..."));
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it("Escape in the instant after the tap (before any render) does not close it either", async () => {
    const release = holdDeduct();
    seedManualCart();
    const { onOpenChange, onSuccess } = renderDialog();

    act(() => {
      fireEvent.click(confirm());
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it("while busy the form is frozen (the fieldset)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const release = holdDeduct();
    seedOrder([CART_ITEM, UNMAPPED_ITEM_A]);
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1);
    });
    renderDialog();
    await user.click(screen.getByRole("checkbox", { name: /Mystery Peptide/ }));

    await user.click(completeButton());
    await waitFor(() => expect(deductCalls()).toHaveLength(1));
    const fieldset = screen.getByRole("alertdialog").querySelector("fieldset");
    expect(fieldset).toHaveAttribute("disabled");
    expect(fieldset).toHaveClass("min-w-0");
    expect(screen.getByRole("checkbox", { name: /Mystery Peptide/ })).toBeDisabled();

    await act(async () => release());
    await waitFor(() => expect(fieldset).not.toHaveAttribute("disabled"));
  });

  it("a FAILED completion stays open, and the latch is released (Complete sends again)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Product 777: Insufficient inventory: current 0, trying to remove 1",
        code: "INSUFFICIENT_STOCK",
      }),
    } as unknown as Response));
    seedManualCart();
    const { onOpenChange, onSuccess } = renderDialog();

    await user.click(confirm());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();

    await waitFor(() => expect(confirm()).toBeEnabled());
    expect(confirm()).toHaveTextContent("Complete Order");
    await user.click(confirm());
    await waitFor(() => expect(deductCalls()).toHaveLength(2));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
