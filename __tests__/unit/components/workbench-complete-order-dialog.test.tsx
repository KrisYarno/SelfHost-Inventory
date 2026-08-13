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
import { render, screen, act, waitFor } from "@testing-library/react";
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

import { CompleteOrderDialog } from "@/components/workbench/complete-order-dialog";
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
  const ui = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <CompleteOrderDialog open={open} onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return { onOpenChange, setOpen: (open: boolean) => view.rerender(ui(open)) };
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

  it("sends nothing when the operator declines with lines still unacknowledged", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_ITEM, UNAVAILABLE_ITEM, UNMAPPED_ITEM_A]);
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
