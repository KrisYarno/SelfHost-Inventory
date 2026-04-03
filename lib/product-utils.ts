export interface GroupedProducts<T extends { baseName?: string | null; name: string }> {
  label: string;
  products: T[];
}

/**
 * Groups products by baseName (case-insensitive key, preserving the first-seen display label).
 * Products without a baseName are grouped under "Other".
 */
export function groupProductsByBaseName<T extends { baseName?: string | null; name: string }>(
  products: T[]
): GroupedProducts<T>[] {
  const groups = new Map<string, { label: string; products: T[] }>();

  for (const product of products) {
    const raw = product.baseName || "Other";
    const key = raw.trim().toLowerCase() || "other";
    const existing = groups.get(key);
    if (existing) {
      existing.products.push(product);
    } else {
      groups.set(key, { label: raw, products: [product] });
    }
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
}
