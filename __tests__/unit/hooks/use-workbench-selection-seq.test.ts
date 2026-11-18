/**
 * Facelift F0 FR2-1 (plan 2026-11-17-facelift-f0, REV 7) — the store's
 * `selectionSeq`, the SELECTION's generation.
 *
 * An order read captures it when it is issued and is stale once it has moved.
 * So every action that changes the selected order or the cart's source moves
 * it — including a re-selection of the SAME order, which an order-id check
 * could not tell apart — and `invalidateInFlightReads` moves it alone. The
 * cart's own edits (quantities, the bin, a hand line, the reference) are not a
 * new selection and leave it where it is.
 */

import { useWorkbench } from "@/hooks/use-workbench";
import type { ExternalOrder } from "@/types/external-orders";
import type { ProductWithQuantity } from "@/types/product";

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

const LINE = {
  id: "x-1",
  orderId: "ord-x",
  externalItemId: null,
  externalProductId: "wc-x-1",
  externalVariantId: null,
  name: "Widget 10mg",
  variantName: null,
  sku: null,
  quantity: 2,
  fulfilledQty: 0,
  price: 10,
  productLinkId: "pl-x-1",
  isMapped: true,
  productLink: { internalProductId: 501, internalProduct: { id: 501 } },
} as unknown as ExternalItem;

const ORDER = {
  id: "ord-x",
  companyId: "co-1",
  integrationId: "int-1",
  externalId: "9001",
  orderNumber: "9001",
  total: 1,
  customerName: "Ada L",
  internalStatus: "processing",
  items: [LINE],
} as unknown as ExternalOrder;

const ROWS = [{ id: 501, name: "Widget 10mg", currentQuantity: 10 }] as unknown as ProductWithQuantity[];

const seq = () => useWorkbench.getState().selectionSeq;
const store = () => useWorkbench.getState();

beforeEach(() => {
  store().clearOrder();
  store().clearQueue();
});

describe("FR2-1 — selectionSeq moves with every new selection", () => {
  it.each<[string, () => void]>([
    ["selectExternalOrder", () => store().selectExternalOrder(ORDER, ROWS, 1)],
    ["clearExternalOrder", () => store().clearExternalOrder()],
    ["setOrderSource('manual')", () => store().setOrderSource("manual")],
    ["setOrderSource('wc-order')", () => store().setOrderSource("wc-order")],
    ["clearOrder", () => store().clearOrder()],
    ["invalidateInFlightReads", () => store().invalidateInFlightReads()],
  ])("%s bumps it by one", (_name, act) => {
    store().selectExternalOrder(ORDER, ROWS, 1);
    const before = seq();
    act();
    expect(seq()).toBe(before + 1);
  });

  it("advanceQueue bumps it when it moves to the next order", () => {
    store().selectExternalOrder(ORDER, ROWS, 1);
    store().addToQueue("NEXT-1");
    const before = seq();
    expect(store().advanceQueue()).toBe("NEXT-1");
    expect(seq()).toBe(before + 1);
  });

  it("selecting the SAME order again is a new selection", () => {
    store().selectExternalOrder(ORDER, ROWS, 1);
    const first = seq();
    store().clearExternalOrder();
    store().selectExternalOrder(ORDER, ROWS, 1);
    expect(store().selectedExternalOrder?.id).toBe("ord-x");
    expect(seq()).toBe(first + 2);
  });

  it("invalidateInFlightReads changes nothing else", () => {
    store().selectExternalOrder(ORDER, ROWS, 1);
    const { selectionSeq: before, ...rest } = store();
    store().invalidateInFlightReads();
    const { selectionSeq: after, ...restAfter } = store();
    expect(after).toBe(before + 1);
    expect(restAfter).toEqual(rest);
    expect(restAfter.orderItems).toBe(rest.orderItems);
    expect(restAfter.selectedExternalOrder).toBe(rest.selectedExternalOrder);
  });

  it("the cart's own edits are not a new selection", () => {
    store().selectExternalOrder(ORDER, ROWS, 1);
    const before = seq();
    store().updateItemQuantity(501, 1, "x-1");
    store().addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1, "manual");
    store().removeItem(777);
    store().setOrderReference("9001-b");
    store().setIsProcessing(true);
    store().setIsProcessing(false);
    store().addToQueue("Q-1");
    store().removeFromQueue(0);
    expect(seq()).toBe(before);
  });
});
