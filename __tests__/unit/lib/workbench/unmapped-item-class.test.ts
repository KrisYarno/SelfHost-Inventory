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
      LOADED_PRODUCTS
    );
  });

  const byId = new Map(
    useWorkbench.getState().unmappedExternalItems.map((i) => [i.externalItemId, i.class])
  );

  expect(byId.get("it-bundle")).toBe("bundle");
  expect(byId.get("it-ghost")).toBe("unavailable");
  expect(byId.get("it-unmapped")).toBe("unmapped");
});
