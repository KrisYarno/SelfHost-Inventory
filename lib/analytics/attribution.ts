import { saleDayKey } from "./dates";

export interface AttributableItem {
  quantity: number; fulfilledQty: number; price: unknown;
  productLink: { internalProductId: number | null; isBundle: boolean } | null;
  bundleComponentSnapshot: unknown;
  order: { companyId: string; integrationId: string; internalStatus: string;
           externalCreatedAt: Date | null; createdAt: Date; id: string };
}
export interface SalesFactAccum { productId: number; companyId: string; integrationId: string; dayKey: string;
  orderedQty: number; fulfilledQty: number; revenueCents: number; orderIds: Set<string>; }
export interface AttributionResult { facts: Map<string, SalesFactAccum>; unattributed: number; }

function priceCents(price: unknown): number {
  return Math.round(Number(price) * 100); // integer cents — truthful to the cent, no float drift
}

export function attributeOrderItems(items: AttributableItem[]): AttributionResult {
  const facts = new Map<string, SalesFactAccum>();
  let unattributed = 0;

  const bump = (productId: number, o: AttributableItem["order"], ordered: number, fulfilled: number, revCents: number) => {
    const dayKey = saleDayKey(o);
    const k = `${productId}|${o.companyId}|${o.integrationId}|${dayKey}`;
    let f = facts.get(k);
    if (!f) { f = { productId, companyId: o.companyId, integrationId: o.integrationId, dayKey, orderedQty: 0, fulfilledQty: 0, revenueCents: 0, orderIds: new Set() }; facts.set(k, f); }
    f.orderedQty += ordered; f.fulfilledQty += fulfilled; f.revenueCents += revCents; f.orderIds.add(o.id);
  };

  for (const it of items) {
    if (it.order.internalStatus === "cancelled") continue; // full cancel/refund/fail; partial refunds NOT netted (round-1)
    const link = it.productLink;

    if (link && !link.isBundle && link.internalProductId != null) {
      bump(link.internalProductId, it.order, it.quantity, it.fulfilledQty, priceCents(it.price) * it.quantity);
      continue;
    }
    if (link && link.isBundle) {
      const snap = it.bundleComponentSnapshot;
      if (Array.isArray(snap) && snap.length > 0) {
        for (const c of snap as { internalProductId: number; quantity: number }[]) {
          bump(c.internalProductId, it.order, c.quantity * it.quantity, c.quantity * it.fulfilledQty, 0); // UNITS only — ER2
        }
        continue;
      }
      unattributed++; continue; // null/empty frozen snapshot: never live-fallback (Pillar-2)
    }
    unattributed++; // unmapped, or mapped with null internalProductId and not a bundle: never silently drop
  }
  return { facts, unattributed };
}
