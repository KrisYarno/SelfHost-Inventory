/**
 * lib/orders/catalog-product-id.ts — THE ONE OWNER OF "IS THIS A STORE CATALOG
 * PRODUCT ID" (hand-typed lines plan, D1 / C1).
 *
 * A store order line can carry no store product: WooCommerce sends
 * `product_id: 0` for a line typed by hand in its order screen (stored as
 * `"0"`), and a missing id is stored as `""`. Neither names a product anybody
 * can map, so intake, both mapping-create routes, the per-line Map buttons, the
 * Unmapped tab and the mappings list all ask THIS module, never a local `=== "0"`.
 *
 * A LEAF: it imports nothing, so it is safe in client and server bundles alike.
 */

/** Store product ids that mean "this line has no store product": WooCommerce sends 0 for a
 *  line typed by hand in the store's order screen; a missing id is stored as "". Compared
 *  after stripping leading/trailing SPACES — exactly what MySQL TRIM() strips. The id
 *  columns use a PAD SPACE collation ("0 " equals "0" in MySQL), and the Unmapped SQL
 *  applies TRIM(), so this guard and the SQL agree on every space-padded spelling. */
export const NO_STORE_PRODUCT_IDS: readonly string[] = ["", "0"];

function stripSpaces(id: string): string {
  return id.replace(/^ +| +$/g, "");
}

/** A one-sided guard: true narrows to string; a false result on a `string` argument narrows
 *  it to `never`, so never read the id in the false branch. */
export function isCatalogProductId(id: string | null | undefined): id is string {
  return typeof id === "string" && !NO_STORE_PRODUCT_IDS.includes(stripSpaces(id));
}

/** The refusal both mapping-create routes return (400). */
export const NO_STORE_PRODUCT_MAPPING_REFUSAL =
  "This store line has no store product id (for example, it was typed by hand in the store's order screen), so there is no store product to map.";

/** Shown in place of a Map button on such a line. */
export const NO_STORE_PRODUCT_LINE_HINT =
  "No store product (for example, typed by hand in the store), so it can't be mapped";

/** The mappings list's primary label for a mapping whose store product id is not a catalog product. */
export const NO_STORE_PRODUCT_MAPPING_LABEL =
  "No store product (for example, lines typed by hand in the store)";

/** The Unmapped tab's note; n >= 1. Exact strings: */
export function noStoreProductNote(n: number): string {
  if (n === 1) {
    return "1 order line has no store product id (for example, it was typed by hand in the store's order screen). It can't be mapped and stays unattributed. Counted across all ages.";
  }
  return `${n} order lines have no store product id (for example, they were typed by hand in the store's order screen). They can't be mapped and stay unattributed. Counted across all ages.`;
}

/** The mappings list's display for a link (row AND delete dialog). */
export function mappingExternalLabel(
  externalProductId: string,
  externalTitle: string | null,
): { primary: string; secondary: string | null } {
  if (!isCatalogProductId(externalProductId)) {
    return {
      primary: NO_STORE_PRODUCT_MAPPING_LABEL,
      secondary: externalTitle ? `Last line seen: ${externalTitle}` : null,
    };
  }
  return { primary: externalTitle || externalProductId, secondary: null };
}
