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

/** Validate a frozen bundle snapshot at the analytics read boundary. Returns the component list only if EVERY
 *  entry has a positive-int internalProductId and quantity (matches the canonical write-time contract); otherwise
 *  null. A null/empty/malformed snapshot must fail closed to `unattributed` — never produce a NaN/garbage fact. */
function validBundleComponents(snap: unknown): { internalProductId: number; quantity: number }[] | null {
  if (!Array.isArray(snap) || snap.length === 0) return null;
  const out: { internalProductId: number; quantity: number }[] = [];
  for (const c of snap) {
    const ip = (c as { internalProductId?: unknown })?.internalProductId;
    const q = (c as { quantity?: unknown })?.quantity;
    if (!Number.isInteger(ip) || (ip as number) <= 0 || !Number.isInteger(q) || (q as number) <= 0) return null;
    out.push({ internalProductId: ip as number, quantity: q as number });
  }
  return out;
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
      const components = validBundleComponents(it.bundleComponentSnapshot);
      if (components) {
        for (const c of components) {
          bump(c.internalProductId, it.order, c.quantity * it.quantity, c.quantity * it.fulfilledQty, 0); // UNITS only — ER2
        }
        continue;
      }
      unattributed++; continue; // null/empty/MALFORMED frozen snapshot: never live-fallback (Pillar-2), never NaN/garbage
    }
    unattributed++; // unmapped, or mapped with null internalProductId and not a bundle: never silently drop
  }
  return { facts, unattributed };
}
