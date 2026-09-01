/** @jest-environment jsdom */
//
// Reconciliation Part 2, pack CB1.5c — the fulfil dialog READS the envelope,
// and counts its lines against the request cap.
//
// The dialog had no suite at all, which is part of how DR-1 stayed invisible:
// it toasted "Order N processed" and called onSuccess for EVERY 200, without
// ever reading `summary.failed`. B1.5 is the wave that makes a partial 200
// reachable in production (a short line comes back as a `skipped` entry), so
// the three tiers are pinned here at the surface the operator actually reads.
//
// The harness follows the workbench dialog suite's idiom: everything the
// component reaches for is mocked at the module edge (its hooks, next-auth,
// sonner), and the locations query is answered through `global.fetch`.
// `@/lib/orders/refusal` is deliberately NOT mocked (DCc-3) — it is a leaf, and
// mocking it would make the refusal pins pass without the real selection ever
// running.

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { isAdmin: false } }, status: "authenticated" }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), message: jest.fn() },
}));
jest.mock("@/hooks/use-orders", () => ({
  useFulfillmentValidation: jest.fn(),
  useFulfillOrder: jest.fn(),
}));
jest.mock("@/components/products/product-map-dialog", () => ({
  ProductMapDialog: () => null,
}));

import { toast } from "sonner";
import { useFulfillmentValidation, useFulfillOrder } from "@/hooks/use-orders";
import { FulfillOrderDialog, openLines } from "@/components/orders/fulfill-order-dialog";
import { MAX_FULFILLMENT_ITEMS, CAP_COUNTER_FROM } from "@/lib/inventory/request-limits";
import type { ExternalOrder } from "@/types/external-orders";

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  isMapped: true,
  ...over,
});

const makeOrder = (items: ExternalItem[]): ExternalOrder =>
  ({
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
  }) as ExternalOrder;

/** N open lines, every one mapped and ready — the cap is the only variable. */
const openOrder = (count: number, extra: ExternalItem[] = []) =>
  makeOrder(
    Array.from({ length: count }, (_, idx) =>
      orderItem({ id: `it-${idx}`, name: `Line ${idx}`, quantity: 2, fulfilledQty: 0 })
    ).concat(extra)
  );

/** Validation that says every line of the order is ready to go. */
function validationFor(order: ExternalOrder) {
  return {
    orderId: order.id,
    canFulfill: true,
    requiresAttention: false,
    items: (order.items ?? []).map((item) => ({
      itemId: item.id,
      name: item.name,
      variantName: null,
      sku: null,
      requestedQty: item.quantity,
      remainingQty: item.quantity - item.fulfilledQty,
      fulfilledQty: item.fulfilledQty,
      isMapped: true,
      mapping: {
        productId: 501,
        productName: "Widget",
        availableByLocation: [{ locationId: 1, locationName: "Main", available: 99 }],
      },
      issues: [] as string[],
    })),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let mutateAsync: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(
    async () =>
      ({ ok: true, json: async () => [{ id: 1, name: "Main" }] }) as unknown as Response
  ) as unknown as typeof fetch;
  mutateAsync = jest.fn(async () => ({ summary: {}, results: {} }));
  (useFulfillOrder as jest.Mock).mockReturnValue({ mutateAsync, isPending: false });
});

/** Render the dialog for `order`, with validation already resolved. */
async function renderDialog(order: ExternalOrder) {
  (useFulfillmentValidation as jest.Mock).mockReturnValue({
    data: validationFor(order),
    isFetching: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = jest.fn();
  const onSuccess = jest.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <FulfillOrderDialog
        order={order}
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        csrfToken="test-csrf"
      />
    </QueryClientProvider>
  );

  // The location auto-selects once /api/locations resolves; the confirm stays
  // disabled until it does.
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  return { onOpenChange, onSuccess };
}

const confirmButton = () =>
  screen.getByRole("button", { name: /Fulfill Order|Fulfill \d+ Items|No Items to Fulfill/ });

/** Render the JSX sonner was handed by `fn`, so its copy can be asserted. */
function toastTitle(fn: jest.Mock): string {
  const body = fn.mock.calls[0][0] as React.ReactElement;
  const { container } = render(<>{body}</>);
  return container.textContent ?? "";
}

const toastOptions = (fn: jest.Mock) => fn.mock.calls[0][1] as { description?: string };

// ---------------------------------------------------------------------------
// THE ENVELOPE (pack CB1.5c / seam S-B15)
// ---------------------------------------------------------------------------

describe("fulfill dialog — the toast tiers by what the server actually did", () => {
  it("NOTHING fulfilled: an error toast carrying the refusal, the dialog stays OPEN, no onSuccess", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mutateAsync.mockResolvedValue({
      summary: { total: 2, fulfilled: 0, skipped: 2, failed: 0 },
      results: {
        fulfilled: [],
        skipped: [
          { itemId: "it-0", reason: "unmapped", details: "Item is not mapped to an internal product" },
          {
            itemId: "it-1",
            reason: "insufficient_stock",
            details: "Insufficient stock for Widget. Available: 1, Requested: 2",
          },
        ],
        failed: [],
      },
    });
    const { onOpenChange, onSuccess } = await renderDialog(openOrder(2));

    await user.click(confirmButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());

    expect(toastTitle(toast.error as jest.Mock)).toContain("Nothing was fulfilled");
    // The refusal is chosen by PRIORITY through the real leaf: the short line,
    // not the pass-1 "unmapped" that sits ahead of it in the array.
    expect(toastOptions(toast.error as jest.Mock).description).toBe(
      "Insufficient stock for Widget. Available: 1, Requested: 2"
    );

    // Nothing moved, so nothing is announced as done and the operator keeps the
    // dialog they were working in.
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toast.success as jest.Mock).not.toHaveBeenCalled();
  });

  it("PARTIAL: a warning toast with the counts and the refusal, then close + onSuccess", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mutateAsync.mockResolvedValue({
      summary: { total: 3, fulfilled: 1, skipped: 1, failed: 1 },
      results: {
        fulfilled: [{ itemId: "it-0", productId: 501, quantity: 2 }],
        skipped: [
          {
            itemId: "it-1",
            reason: "insufficient_stock",
            details: "Insufficient stock for Vial. Available: 0, Requested: 2",
          },
        ],
        failed: [{ itemId: "it-2", error: "Item not found in order" }],
      },
    });
    const { onOpenChange, onSuccess } = await renderDialog(openOrder(3));

    await user.click(confirmButton());
    await waitFor(() => expect(toast.warning as jest.Mock).toHaveBeenCalled());

    expect(toastTitle(toast.warning as jest.Mock)).toContain("Order 9001 partially processed");
    expect(toastOptions(toast.warning as jest.Mock).description).toBe(
      "1 fulfilled, 1 skipped, 1 failed — Insufficient stock for Vial. Available: 0, Requested: 2"
    );

    // The order IS partly fulfilled — legitimate state, so the surface behind
    // the dialog has to refresh into it.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalled();
    expect(toast.success as jest.Mock).not.toHaveBeenCalled();
  });

  it("FULL: the success toast names the fulfilled count and nothing that is zero", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mutateAsync.mockResolvedValue({
      summary: { total: 2, fulfilled: 2, skipped: 0, failed: 0 },
      results: { fulfilled: [{ itemId: "it-0" }, { itemId: "it-1" }], skipped: [], failed: [] },
    });
    const { onOpenChange, onSuccess } = await renderDialog(openOrder(2));

    await user.click(confirmButton());
    await waitFor(() => expect(toast.success as jest.Mock).toHaveBeenCalled());

    expect(toastTitle(toast.success as jest.Mock)).toContain("Order 9001 processed");
    expect(toastOptions(toast.success as jest.Mock).description).toBe("2 fulfilled");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE CAP GUARD (QB-3 / seam S-B10) — the numbers come from the ONE owner
// ---------------------------------------------------------------------------

describe("fulfill dialog — the request cap, counted before it bites", () => {
  it("openLines counts only what would be SENT — a fully fulfilled line is not open", () => {
    // The pure predicate, pinned directly: the dialog's counter and the request
    // it counts are one spelling, so this is the whole rule.
    const lines = [
      orderItem({ id: "a", quantity: 2, fulfilledQty: 0 }),
      orderItem({ id: "b", quantity: 2, fulfilledQty: 2 }),
      orderItem({ id: "c", quantity: 3, fulfilledQty: 1 }),
    ];

    expect(openLines(lines).map((line) => line.id)).toEqual(["a", "c"]);
    expect(openLines([])).toEqual([]);
  });

  it("no counter at 50 open lines", async () => {
    await renderDialog(openOrder(50));

    expect(screen.queryByText(new RegExp(`of ${MAX_FULFILLMENT_ITEMS} lines`))).toBeNull();
    expect(confirmButton()).toBeEnabled();
  });

  it(`the counter appears above ${CAP_COUNTER_FROM}`, async () => {
    await renderDialog(openOrder(CAP_COUNTER_FROM + 1));

    expect(screen.getByText(`${CAP_COUNTER_FROM + 1} of ${MAX_FULFILLMENT_ITEMS} lines`))
      .toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("at exactly the cap the confirm is still enabled", async () => {
    await renderDialog(openOrder(MAX_FULFILLMENT_ITEMS));

    expect(
      screen.getByText(`${MAX_FULFILLMENT_ITEMS} of ${MAX_FULFILLMENT_ITEMS} lines`)
    ).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("one line over the cap: the confirm is refused with a sentence that says why", async () => {
    const over = MAX_FULFILLMENT_ITEMS + 1;
    (useFulfillmentValidation as jest.Mock).mockReturnValue({
      data: validationFor(openOrder(over)),
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <FulfillOrderDialog
          order={openOrder(over)}
          open
          onOpenChange={jest.fn()}
          onSuccess={jest.fn()}
          csrfToken="test-csrf"
        />
      </QueryClientProvider>
    );

    expect(
      await screen.findByText(
        `This order has ${over} open lines; fulfilment handles at most ${MAX_FULFILLMENT_ITEMS} per request.`
      )
    ).toBeInTheDocument();
    // Never a dead button with no reason on screen.
    expect(confirmButton()).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("fulfilled lines do not count against the cap", async () => {
    // 100 open + 3 already fully fulfilled = 103 lines, 100 of them sendable.
    const closed = Array.from({ length: 3 }, (_, idx) =>
      orderItem({ id: `done-${idx}`, name: `Done ${idx}`, quantity: 2, fulfilledQty: 2 })
    );
    await renderDialog(openOrder(MAX_FULFILLMENT_ITEMS, closed));

    expect(
      screen.getByText(`${MAX_FULFILLMENT_ITEMS} of ${MAX_FULFILLMENT_ITEMS} lines`)
    ).toBeInTheDocument();
    expect(screen.queryByText(/fulfilment handles at most/)).toBeNull();
    expect(confirmButton()).toBeEnabled();
  });
});
