export interface WoosbItem {
  productId: string;
  variantId: string | null;
  quantity: number;
}

const ENTRY_RE = /^(\d+)(?:\|(\d+))?(?:\/(\d+))?$/;

/**
 * Parse WPC's _woosb_ids meta value.
 *
 * Format examples:
 *   "123/2"            → simple-product child id=123, qty=2
 *   "123|456/2"        → variation child product=123 variation=456 qty=2 (D6)
 *   "123"              → simple-product child id=123, qty=1 (default)
 *   "123/2,456/1"      → multiple entries comma-separated
 *
 * Malformed entries are silently dropped. Non-positive quantities also dropped.
 */
export function parseWoosbIds(raw: string | null | undefined): WoosbItem[] {
  if (!raw) return [];
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out: WoosbItem[] = [];
  for (const entry of entries) {
    const match = ENTRY_RE.exec(entry);
    if (!match) continue;
    const [, productId, variantId, qtyRaw] = match;
    const quantity = qtyRaw ? parseInt(qtyRaw, 10) : 1;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    out.push({
      productId,
      variantId: variantId ?? null,
      quantity,
    });
  }
  return out;
}
