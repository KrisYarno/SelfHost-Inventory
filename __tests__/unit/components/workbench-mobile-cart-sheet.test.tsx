/** @jest-environment jsdom */
//
// Facelift F0-1 (plan 2026-11-17-facelift-f0, part 4 + folds (c), (d)) — the
// phone sees every line.
//
// FL-C-1: the phone's cart sheet rendered only the deductible cart. Unmapped,
// unavailable, bundle and (now) out-of-stock lines lived on a banner BEHIND the
// sheet and came back only at the confirm step, after the box was packed. The
// sheet now renders the same `UnmappedItemsAlert` the page renders, with the
// same props, first inside ONE scroll region it shares with the order list
// (the footer stays pinned), collapsed to start. An order with nothing
// deductible says so instead of "Click on products", and its Clear works.

import * as React from "react";
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { isAdmin: true } } }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), info: jest.fn(), message: jest.fn() },
}));
// The map dialog is a seam of its own: here it only has to hand `onMapped` back.
jest.mock("@/components/products/product-map-dialog", () => ({
  ProductMapDialog: ({ open, integrationId, onMapped }: { open: boolean; integrationId: string; onMapped: () => void }) =>
    open ? (
      <button type="button" data-integration={integrationId} onClick={onMapped}>
        Finish mapping
      </button>
    ) : null,
}));

import { MobileCartSheet } from "@/components/workbench/mobile-cart-sheet";
import { useWorkbench } from "@/hooks/use-workbench";
import type { ExternalOrder } from "@/types/external-orders";
import type { ProductWithQuantity } from "@/types/product";

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

const orderItem = (over: Partial<ExternalItem>): ExternalItem =>
  ({
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
  }) as ExternalItem;

const mapped = (id: string, name: string, productId: number, quantity: number) =>
  orderItem({
    id,
    name,
    quantity,
    isMapped: true,
    productLink: { internalProductId: productId, internalProduct: { id: productId } } as never,
  });

const CART_LINE = mapped("it-cart", "Widget In Stock", 501, 2);
const OUT_OF_STOCK_LINE = mapped("it-oos", "Empty Here", 504, 1);
const UNMAPPED_LINE = orderItem({ id: "it-unmapped", name: "Mystery Peptide", externalProductId: "wc-p-777" });

const PRODUCTS = [
  { id: 501, name: "Widget In Stock", currentQuantity: 10 },
  { id: 504, name: "Empty Here", currentQuantity: 0 },
] as unknown as ProductWithQuantity[];

const makeOrder = (items: ExternalItem[]): ExternalOrder =>
  ({
    id: "ord-1",
    companyId: "co-1",
    integrationId: "int-1",
    externalId: "9001",
    orderNumber: "9001",
    total: 1,
    customerName: "Ada L",
    internalStatus: "processing",
    items,
  }) as unknown as ExternalOrder;

function seedOrder(items: ExternalItem[]) {
  act(() => {
    useWorkbench.getState().selectExternalOrder(makeOrder(items), PRODUCTS, 1);
  });
}

function renderSheet(
  over: { canComplete?: boolean; updatingNotice?: string | null; cartReadOnly?: boolean } = {}
) {
  const props = {
    onOpenChange: jest.fn(),
    onClearOrder: jest.fn(),
    onItemMapped: jest.fn(),
    onCompleteOrder: jest.fn(),
  };
  const state = useWorkbench.getState();
  render(
    <MobileCartSheet
      open
      onOpenChange={props.onOpenChange}
      orderReference={state.orderReference}
      onOrderReferenceChange={jest.fn()}
      totalItems={state.orderItems.length}
      totalQuantity={state.getTotalQuantity()}
      onClearOrder={props.onClearOrder}
      onCompleteOrder={props.onCompleteOrder}
      canComplete={over.canComplete ?? false}
      updatingNotice={over.updatingNotice}
      cartReadOnly={over.cartReadOnly}
      queuePosition={null}
      onItemMapped={props.onItemMapped}
    />
  );
  return props;
}

const clearButton = () => screen.getByRole("button", { name: /Clear/ });

let confirmSpy: jest.SpyInstance;

beforeEach(() => {
  act(() => {
    useWorkbench.getState().clearOrder();
  });
  confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe("F0-1 — the sheet renders the skipped lines", () => {
  it("renders the skipped-lines alert first, inside the ONE scroll region it shares with the order list", () => {
    seedOrder([CART_LINE, UNMAPPED_LINE, OUT_OF_STOCK_LINE]);
    renderSheet();

    const header = screen.getByTestId("skipped-lines-header");
    expect(header).toHaveTextContent("1 unmapped line + 1 out-of-stock line will not be deducted");

    const region = header.closest(".overflow-y-auto") as HTMLElement;
    expect(region).not.toBeNull();
    expect(region).toHaveClass("flex-1", "min-h-0", "overflow-y-auto");

    // The cart line is in the SAME region, after the alert.
    const cartLine = screen.getByRole("heading", { name: "Widget In Stock" });
    expect(region).toContainElement(cartLine);
    expect(header.compareDocumentPosition(cartLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The footer stays pinned: Clear is NOT inside the scroll region.
    expect(region).not.toContainElement(clearButton());
  });

  it("starts collapsed in the sheet, even for a short list", () => {
    seedOrder([CART_LINE, UNMAPPED_LINE, OUT_OF_STOCK_LINE]);
    renderSheet();

    expect(screen.getByTestId("skipped-lines-header")).toBeInTheDocument();
    expect(screen.queryByText("Mystery Peptide")).toBeNull();
    expect(screen.queryByText("Empty Here")).toBeNull();
  });

  it("opening it shows every skipped line, with the shared copy", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_LINE, UNMAPPED_LINE, OUT_OF_STOCK_LINE]);
    renderSheet();

    await user.click(screen.getByTestId("skipped-lines-header"));
    expect(screen.getByText("Mystery Peptide")).toBeInTheDocument();
    expect(screen.getByText("Empty Here")).toBeInTheDocument();
    expect(screen.getByText("none in stock here — not deducted")).toBeInTheDocument();
  });

  it("the inline Map reaches the page's onItemMapped, with the order's integration", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_LINE, UNMAPPED_LINE]);
    const { onItemMapped } = renderSheet();

    await user.click(screen.getByTestId("skipped-lines-header"));
    await user.click(screen.getByRole("button", { name: /^map$/i }));
    const finish = screen.getByRole("button", { name: "Finish mapping" });
    expect(finish).toHaveAttribute("data-integration", "int-1");

    await user.click(finish);
    expect(onItemMapped).toHaveBeenCalledTimes(1);
  });

  it("a manual cart shows no alert", () => {
    act(() => {
      useWorkbench.getState().addItem(PRODUCTS[0], 1, "manual");
    });
    renderSheet();

    expect(screen.queryByTestId("skipped-lines-header")).toBeNull();
  });
});

describe("F0-1 — a store order with nothing deductible", () => {
  it("the list area says so, instead of the 'Click on products' copy", () => {
    seedOrder([UNMAPPED_LINE, OUT_OF_STOCK_LINE]);
    renderSheet();

    expect(screen.getByText("Nothing from this order can be deducted here.")).toBeInTheDocument();
    expect(screen.queryByText("Click on products to add them")).toBeNull();
  });

  it("Clear is enabled and clears the order with no confirm (nothing to lose)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([UNMAPPED_LINE, OUT_OF_STOCK_LINE]);
    const { onClearOrder } = renderSheet();

    expect(clearButton()).toBeEnabled();
    await user.click(clearButton());

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClearOrder).not.toHaveBeenCalled();
    expect(useWorkbench.getState().selectedExternalOrder).toBeNull();
    expect(useWorkbench.getState().unmappedExternalItems).toHaveLength(0);
  });

  // Orchestrator ruling on F0a deviation #4: like today's Clear-with-items
  // (the page's handler closes the sheet), the empty-order Clear closes it too —
  // after the order is cleared, never instead of clearing it.
  it("Clear closes the sheet after clearing the order", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([UNMAPPED_LINE, OUT_OF_STOCK_LINE]);
    const { onOpenChange } = renderSheet();

    let clearedWhenClosed: boolean | null = null;
    onOpenChange.mockImplementation(() => {
      clearedWhenClosed = useWorkbench.getState().selectedExternalOrder === null;
    });
    await user.click(clearButton());

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(clearedWhenClosed).toBe(true);
  });
});

describe("F0-1 — the manual sheet is unchanged", () => {
  it("an empty manual cart: the 'Click on products' copy, and Clear disabled", () => {
    renderSheet();

    expect(screen.getByText("Click on products to add them")).toBeInTheDocument();
    expect(screen.queryByText("Nothing from this order can be deducted here.")).toBeNull();
    expect(clearButton()).toBeDisabled();
  });

  it("a manual cart's Clear is still the page's (with its confirm)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    act(() => {
      useWorkbench.getState().addItem(PRODUCTS[0], 1, "manual");
    });
    const { onClearOrder } = renderSheet();

    await user.click(clearButton());
    expect(onClearOrder).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-2 — "can be deducted here" only when the build found nothing
// ---------------------------------------------------------------------------

describe("FR1-2 — the empty store-order sentence follows what the build produced", () => {
  it("lines built and then binned: `Nothing from this order is in the cart.`, never `can be deducted here`", () => {
    seedOrder([CART_LINE, OUT_OF_STOCK_LINE]);
    act(() => {
      useWorkbench.getState().removeItem(501, "it-cart");
    });
    expect(useWorkbench.getState().selectedExternalOrder?.builtCartCount).toBe(1);
    renderSheet();

    expect(screen.getByText("Nothing from this order is in the cart.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing from this order can be deducted here.")).toBeNull();
    // Clear is unchanged: enabled, and it clears the order.
    expect(clearButton()).toBeEnabled();
  });

  it("a build with nothing deductible keeps `Nothing from this order can be deducted here.`", () => {
    seedOrder([UNMAPPED_LINE, OUT_OF_STOCK_LINE]);
    expect(useWorkbench.getState().selectedExternalOrder?.builtCartCount).toBe(0);
    renderSheet();

    expect(screen.getByText("Nothing from this order can be deducted here.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing from this order is in the cart.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-1 (d) — while the order is rebuilt for this location
// ---------------------------------------------------------------------------

describe("FR1-1 (d) — the sheet while the order is being updated", () => {
  const NOTICE = "Updating this order for Overflow…";

  it("a muted line above Complete says why, and Complete is disabled", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    seedOrder([CART_LINE]);
    const { onCompleteOrder } = renderSheet({ canComplete: false, updatingNotice: NOTICE });

    const notice = screen.getByText(NOTICE);
    expect(notice).toHaveClass("text-muted-foreground");
    const complete = screen.getByRole("button", { name: "Complete & Fulfill" });
    expect(notice.compareDocumentPosition(complete) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(complete).toBeDisabled();
    await user.click(complete);
    expect(onCompleteOrder).not.toHaveBeenCalled();
  });

  it("no notice when nothing is pending", () => {
    seedOrder([CART_LINE]);
    renderSheet({ canComplete: true, updatingNotice: null });

    expect(screen.queryByText(/^Updating this order/)).toBeNull();
    expect(screen.getByRole("button", { name: "Complete & Fulfill" })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR2-1 (REV 7): while the order is being updated the cart is
// read-only — on the phone too. The page hands the sheet `cartReadOnly`, and
// the sheet's order list disables every line's steppers, editor and bin.
// ---------------------------------------------------------------------------

describe("FR2-1 — the sheet's cart is read-only while the order updates", () => {
  const lineButtons = () => {
    const row = screen.getByRole("heading", { level: 4, name: "Widget In Stock" }).closest("div.rounded-xl");
    return within(row as HTMLElement).getAllByRole("button");
  };

  it("cartReadOnly: the line's steppers, quantity editor and bin are disabled", () => {
    seedOrder([CART_LINE]);
    renderSheet({ cartReadOnly: true, updatingNotice: "Updating this order for Overflow…" });

    const buttons = lineButtons();
    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(button).toBeDisabled();
  });

  it("without it, the line is live (unchanged)", () => {
    seedOrder([CART_LINE]);
    renderSheet();

    // − (2 > 1), the quantity, + (2 < 10) and the bin.
    for (const button of lineButtons()) expect(button).toBeEnabled();
  });
});
