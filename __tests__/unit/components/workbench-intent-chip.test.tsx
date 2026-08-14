/** @jest-environment jsdom */
//
// W2-1 (contract pack REV-11 T7, [ADJ per PLG1-1) — the chip on the WORKBENCH
// manual leg offers TWO values, never damage-loss.
//
// Why the asymmetry is load-bearing: the manual leg books SALE rows, and
// getShrinkageSummary narrows to `logType IN (ADJUSTMENT, CORRECTION)` BEFORE
// any reason is classified. A SALE row carrying reasonCode DAMAGE would be a
// loss that is recorded and then never counted by the only surface that reports
// losses — worse than not offering the choice. The route refuses the value too
// (see __tests__/integration/api/w2-intent-chip.test.ts); this file pins that
// the surface never asks for it.
//
// Harness follows __tests__/unit/components/workbench-complete-order-dialog.tsx:
// the order is seeded through the REAL zustand store so these pins cover the
// hook -> dialog seam, not just the renderer.
import * as React from "react";
import { render, screen, act, waitFor, within } from "@testing-library/react";
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

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

const MANUAL_LINE = {
  id: "it-cart",
  orderId: "ord-1",
  externalItemId: null,
  externalProductId: "wc-p-1",
  externalVariantId: null,
  name: "Widget In Stock",
  variantName: null,
  sku: null,
  quantity: 2,
  fulfilledQty: 0,
  price: 10,
  productLinkId: "pl-1",
  isMapped: true,
  productLink: {
    id: "pl-1",
    internalProductId: 501,
    externalSku: null,
    externalTitle: null,
    internalProduct: { id: 501, name: "Widget In Stock", baseName: null, variant: null },
  },
} as unknown as ExternalItem;

const makeOrder = (items: ExternalItem[]): ExternalOrder =>
  ({
    id: "ord-1",
    companyId: "co-1",
    integrationId: "int-1",
    externalId: "9001",
    orderNumber: "9001",
    total: 123.45,
    internalStatus: "processing",
    items,
  }) as unknown as ExternalOrder;

const LOADED_PRODUCTS = [
  { id: 501, name: "Widget In Stock", currentQuantity: 10 },
] as unknown as ProductWithQuantity[];

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

/**
 * A cart with a MANUAL line: the WC order is selected (so the chip has an order
 * to attribute to) but the cart entry carries no fulfillmentItemId, which is
 * exactly what routes it through deduct-simple.
 */
function seedManualCart() {
  act(() => {
    useWorkbench.getState().selectExternalOrder(makeOrder([MANUAL_LINE]), LOADED_PRODUCTS);
    // Strip the fulfillment id so the line is a MANUAL deduction.
    useWorkbench.setState({
      orderItems: useWorkbench
        .getState()
        .orderItems.map(({ fulfillmentItemId: _drop, ...rest }) => rest),
    });
  });
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CompleteOrderDialog open onOpenChange={jest.fn()} />
    </QueryClientProvider>
  );
}

async function completeAndReadDeductBody(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Complete/ }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]) === "/api/inventory/deduct-simple")
    ).toBe(true)
  );
  const call = fetchMock.mock.calls.find(
    (c) => String(c[0]) === "/api/inventory/deduct-simple"
  )!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

const chipGroup = () => within(screen.getByRole("radiogroup", { name: "What was this for?" }));

describe("workbench manual leg — the chip offers no damage-loss (PLG1-1)", () => {
  it("renders exactly two values", () => {
    seedManualCart();
    renderDialog();

    expect(chipGroup().getAllByRole("radio")).toHaveLength(2);
    expect(chipGroup().getByRole("radio", { name: "Order" })).toBeInTheDocument();
    expect(chipGroup().getByRole("radio", { name: "Other" })).toBeInTheDocument();
    expect(chipGroup().queryByRole("radio", { name: /damage/i })).toBeNull();
  });
});

describe("workbench manual leg — the chip never blocks", () => {
  it("completes with no chip interaction and sends NO intent", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedManualCart();
    renderDialog();

    const body = await completeAndReadDeductBody(user);

    expect("intent" in body).toBe(false);
    // 0b-2's accrual is untouched by the chip's absence.
    expect(body.selectedExternalOrderId).toBe("ord-1");
  });

  it("sends intent order once the operator taps it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedManualCart();
    renderDialog();

    await user.click(chipGroup().getByRole("radio", { name: "Order" }));
    const body = await completeAndReadDeductBody(user);

    expect(body.intent).toBe("order");
    expect(body.selectedExternalOrderId).toBe("ord-1");
  });
});
