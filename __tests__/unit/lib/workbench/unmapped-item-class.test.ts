/** @jest-environment jsdom */
//
// W2-1 ride-along — the hook RECORDS the class at every push site.
//
// hooks/use-workbench.ts `selectExternalOrder` has three branches that push
// into `unmappedExternalItems`, and each one knows exactly which truth it is
// pushing. These pins drive the REAL store so the field cannot drift away from
// the branch that sets it: a fixture-based test would keep passing if a branch
// stopped stamping.
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), message: jest.fn() },
}));

import { act } from "@testing-library/react";
import { toast } from "sonner";
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

const makeOrder = (items: ExternalItem[]): ExternalOrder =>
  ({
    id: "ord-1",
    companyId: "co-1",
    integrationId: "int-1",
    externalId: "9001",
    orderNumber: "9001",
    total: 1,
    internalStatus: "processing",
    items,
  }) as unknown as ExternalOrder;

const LOADED_PRODUCTS = [
  { id: 501, name: "Widget In Stock", currentQuantity: 10 },
] as unknown as ProductWithQuantity[];

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useWorkbench.getState().clearOrder();
  });
});

it("stamps the structural class on all three push sites", () => {
  act(() => {
    useWorkbench.getState().selectExternalOrder(
      makeOrder([
        // mapped + bundle -> bundle
        orderItem({
          id: "it-bundle",
          isMapped: true,
          productLink: { internalProductId: 502, isBundle: true } as any,
        }),
        // mapped, but internalProductId 900 is not in the loaded products
        orderItem({
          id: "it-ghost",
          isMapped: true,
          productLink: { internalProductId: 900, internalProduct: { id: 900 } } as any,
        }),
        // never mapped
        orderItem({ id: "it-unmapped", externalProductId: "wc-p-777" }),
      ]),
      LOADED_PRODUCTS,
      1
    );
  });

  const byId = new Map(
    useWorkbench.getState().unmappedExternalItems.map((i) => [i.externalItemId, i.class])
  );

  expect(byId.get("it-bundle")).toBe("bundle");
  expect(byId.get("it-ghost")).toBe("unavailable");
  expect(byId.get("it-unmapped")).toBe("unmapped");
});

// ---------------------------------------------------------------------------
// Facelift F0-1 (plan 2026-11-17-facelift-f0, parts 2 + 3, fold (b)).
//
// FL-C-2: a mapped single whose loaded product had NOTHING in stock here was
// capped to 0 and then pushed nowhere — not into the cart, not into
// `unmappedExternalItems` — so it vanished from every surface while a toast
// that expired was the only record. And a short line kept only its capped
// quantity. These pins drive the real store, branch by branch.
// ---------------------------------------------------------------------------

/** A mapped single whose internal product id is `productId`. */
const mappedSingle = (id: string, productId: number, over: Partial<ExternalItem> = {}) =>
  orderItem({
    id,
    name: `Line ${id}`,
    sku: `SKU-${id}`,
    isMapped: true,
    productLink: { internalProductId: productId, internalProduct: { id: productId } } as any,
    ...over,
  });

const STOCKED = [
  { id: 601, name: "Zero Here", currentQuantity: 0 },
  { id: 602, name: "Negative Here", currentQuantity: -2 },
  { id: 603, name: "Three Here", currentQuantity: 3 },
  { id: 604, name: "Plenty Here", currentQuantity: 50 },
] as unknown as ProductWithQuantity[];

const select = (items: ExternalItem[]) =>
  act(() => {
    useWorkbench.getState().selectExternalOrder(makeOrder(items), STOCKED, 1);
  });

describe("F0-1 — an ordered line is never dropped", () => {
  it("a 0-stock mapped single becomes an 'out-of-stock' skipped line, not a dropped one", () => {
    select([mappedSingle("it-zero", 601, { quantity: 4, fulfilledQty: 1 })]);

    const state = useWorkbench.getState();
    expect(state.orderItems).toHaveLength(0);
    expect(state.unmappedExternalItems).toEqual([
      {
        name: "Line it-zero",
        sku: "SKU-it-zero",
        quantity: 3, // the REMAINING quantity (4 ordered, 1 already fulfilled)
        externalItemId: "it-zero",
        class: "out-of-stock",
      },
    ]);
  });

  it("negative stock here is out of stock too (the <= 0 boundary)", () => {
    select([mappedSingle("it-neg", 602, { quantity: 2 })]);

    const state = useWorkbench.getState();
    expect(state.orderItems).toHaveLength(0);
    expect(state.unmappedExternalItems.map((i) => [i.externalItemId, i.class])).toEqual([
      ["it-neg", "out-of-stock"],
    ]);
  });

  it("the out-of-stock line is ON SCREEN now, so its passing warning toast is gone", () => {
    select([mappedSingle("it-zero", 601, { quantity: 2 })]);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe("F0-1 — a short line keeps what the order needs", () => {
  it("is still capped at stock, stamps neededQuantity, and keeps the cap toast", () => {
    select([mappedSingle("it-short", 603, { quantity: 5 })]);

    const [line] = useWorkbench.getState().orderItems;
    expect(line.quantity).toBe(3); // deduction unchanged: capped at stock
    expect(line.neededQuantity).toBe(5);
    expect(useWorkbench.getState().unmappedExternalItems).toHaveLength(0);
    expect(toast.warning).toHaveBeenCalledWith("Three Here: order needs 5, only 3 in stock");
  });

  it("stamps neededQuantity (the REMAINING quantity) on EVERY store-order cart line", () => {
    select([mappedSingle("it-full", 604, { quantity: 6, fulfilledQty: 2 })]);

    const [line] = useWorkbench.getState().orderItems;
    expect(line.quantity).toBe(4);
    expect(line.neededQuantity).toBe(4);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("a hand-added line carries no neededQuantity", () => {
    act(() => {
      useWorkbench.getState().addItem(STOCKED[3], 2, "manual");
    });
    expect(useWorkbench.getState().orderItems[0].neededQuantity).toBeUndefined();
  });
});
