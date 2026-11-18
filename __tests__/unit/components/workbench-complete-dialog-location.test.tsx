/** @jest-environment jsdom */
//
// Facelift F0 FR2-2 (plan 2026-11-17-facelift-f0, REV 7; FD1-2) — the
// completion dialog checks the location ITSELF. CRITICAL: this dialog posts the
// fulfil and deduct requests.
//
// A store order's cart describes the stock of the location that built it
// (`builtAtLocationId`, FR1-1). The page waits while that is not the selected
// location — but the page's gate was the only one: a dialog already open, or
// any path that opened it, would post a cart read at one location against
// another. Now the dialog's own action is disabled while they differ, its
// submit handler refuses, and it says why, muted:
//   `This order is being updated for ${locationName} — wait a moment.`
//
// Own file, with its own location context: the main dialog suite (and its
// request-body byte-identity pin) runs at one fixed location.

import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false, error: null, refreshToken: jest.fn() }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "test-csrf" }),
}));
type Loc = { id: number; name: string };
const MAIN: Loc = { id: 1, name: "Main" };
const OVERFLOW: Loc = { id: 2, name: "Overflow" };
let mockLocation: { selectedLocationId: number | null; selectedLocation: Loc | null };
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => mockLocation,
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), message: jest.fn(), info: jest.fn() },
}));

import { CompleteOrderDialog } from "@/components/workbench/complete-order-dialog";
import { useWorkbench } from "@/hooks/use-workbench";
import type { ExternalOrder } from "@/types/external-orders";
import type { ProductWithQuantity } from "@/types/product";

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

const CART_LINE = {
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
  productLink: { internalProductId: 501, internalProduct: { id: 501 } },
} as unknown as ExternalItem;

const ORDER = {
  id: "ord-1",
  companyId: "co-1",
  integrationId: "int-1",
  externalId: "9001",
  orderNumber: "9001",
  total: 12,
  customerName: "Ada L",
  internalStatus: "processing",
  items: [CART_LINE],
} as unknown as ExternalOrder;

const ROWS = [{ id: 501, name: "Widget In Stock", currentQuantity: 10 }] as unknown as ProductWithQuantity[];

const UPDATING_OVERFLOW = "This order is being updated for Overflow — wait a moment.";
const UPDATING_ANY = /^This order is being updated for /;

let fetchMock: jest.Mock;
beforeEach(() => {
  mockLocation = { selectedLocationId: 1, selectedLocation: MAIN };
  fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as unknown as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  act(() => {
    useWorkbench.getState().clearOrder();
  });
});

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={queryClient}>
      <CompleteOrderDialog open onOpenChange={jest.fn()} onSuccess={jest.fn()} />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { rerender: () => view.rerender(ui()) };
}

const action = (name: string) => screen.getByRole("button", { name });
const fulfilCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/orders/ord-1/fulfill");

describe("FR2-2 — the dialog checks the location itself", () => {
  it("a store order built at Main while the shell says Overflow: the action is disabled, the dialog says why, and nothing is sent", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER, ROWS, 1);
    });
    mockLocation = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    renderDialog();

    expect(action("Complete & Fulfill")).toBeDisabled();
    const line = screen.getByText(UPDATING_OVERFLOW);
    expect(line).toHaveClass("text-muted-foreground");

    await act(async () => {
      action("Complete & Fulfill").click();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the submit handler refuses too, even when reached past the disabled action", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER, ROWS, 1);
    });
    mockLocation = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    renderDialog();

    // The belt under the disabled button: call the action's own click handler
    // directly (React's props on the node), as any path that skipped the
    // `disabled` attribute would.
    const node = action("Complete & Fulfill") as unknown as Record<string, unknown>;
    const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
    expect(propsKey).toBeDefined();
    const props = node[propsKey!] as { onClick: (e: { preventDefault: () => void }) => void };
    await act(async () => {
      props.onClick({ preventDefault: () => {} });
    });
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("built here: the action is live, there is no line, and the fulfil request goes out (unchanged)", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER, ROWS, 1);
    });
    renderDialog();

    expect(action("Complete & Fulfill")).toBeEnabled();
    expect(screen.queryByText(UPDATING_ANY)).toBeNull();

    await act(async () => {
      action("Complete & Fulfill").click();
    });
    expect(fulfilCalls()).toHaveLength(1);
  });

  it("the location changing while the dialog is open disables it at once", () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER, ROWS, 1);
    });
    const { rerender } = renderDialog();
    expect(action("Complete & Fulfill")).toBeEnabled();

    mockLocation = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    rerender();
    expect(action("Complete & Fulfill")).toBeDisabled();
    expect(screen.getByText(UPDATING_OVERFLOW)).toBeInTheDocument();
  });

  it("an order whose build read no one location's rows (null) is not built here either", () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER, ROWS, null);
    });
    renderDialog();

    expect(action("Complete & Fulfill")).toBeDisabled();
    expect(screen.getByText("This order is being updated for Main — wait a moment.")).toBeInTheDocument();
  });

  // Facelift F1-10 (F0 FD2-4): the null/null edge — a build that read no one
  // location's rows, with no location selected. `null !== null` is false, so the
  // check used to call that cart built here; it is stated outright now.
  it("F1-10 — null/null: a build from no one location's rows, with no location selected, is not built here", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER, ROWS, null);
    });
    mockLocation = { selectedLocationId: null, selectedLocation: null };
    renderDialog();

    expect(action("Complete & Fulfill")).toBeDisabled();
    expect(
      screen.getByText("This order is being updated for the selected location — wait a moment.")
    ).toBeInTheDocument();

    // The submit handler refuses as well, past the disabled action.
    const node = action("Complete & Fulfill") as unknown as Record<string, unknown>;
    const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
    const props = node[propsKey!] as { onClick: (e: { preventDefault: () => void }) => void };
    await act(async () => {
      props.onClick({ preventDefault: () => {} });
    });
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the location's name falls back as the page's does while it is unknown", () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER, ROWS, 1);
    });
    mockLocation = { selectedLocationId: 2, selectedLocation: null };
    renderDialog();

    expect(screen.getByText("This order is being updated for the selected location — wait a moment.")).toBeInTheDocument();
  });

  it("a manual cart is not a store order: no check, no line", () => {
    act(() => {
      useWorkbench.getState().addItem(ROWS[0], 1, "manual");
      useWorkbench.getState().setOrderReference("M-1");
    });
    mockLocation = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    renderDialog();

    expect(action("Complete Order")).toBeEnabled();
    expect(screen.queryByText(UPDATING_ANY)).toBeNull();
  });
});
