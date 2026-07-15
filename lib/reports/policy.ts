/**
 * lib/reports/policy.ts — the inventory-policy reader (assistant toolsuite breadth,
 * spec §5 T-POL / plan Task W1-POL).
 *
 * Surfaces the RAW per-product override columns alongside their effective values and
 * a TRUE `source` label, per field. The whole point (spec: "kills thresholdSource-by-
 * equality"): source is decided from whether the product's raw column is non-null —
 * NEVER by comparing the effective value to the default. An override that happens to
 * equal the system default still reads `"product_override"`; the raw-null case reads
 * `"system_default"` even though its effective value is identical.
 *
 * Building blocks REUSED, not reimplemented:
 *  - `getLowStockDefault` / `effectiveLowStockThreshold` (lib/stock-threshold.ts) — the
 *    one shared home for low-stock threshold semantics (also used by
 *    lib/reports/low-stock.ts, which this module does NOT touch or import).
 *  - `getGlobalReorderSettings` / `resolveReorderConfig` (lib/reorder-config.ts,
 *    W0-4, READ-ONLY) — the reorder-field inheritance + clamping rules. This module
 *    does not duplicate any of that clamping logic; it only re-derives the `source`
 *    label from the raw column, independently of the (possibly clamped) effective
 *    value resolveReorderConfig returns.
 *  - `resolveAssistantProduct` (lib/assistant/resolve-product.ts, Next-free) — the one
 *    approved+non-deleted visibility predicate every productId-taking assistant tool
 *    uses. An unknown/pending/deleted productId resolves to `{ global }` with
 *    `product: undefined`; the caller (tool layer) is responsible for turning that into
 *    a `notFound("product", id)` result — this module never throws for a bad id.
 *
 * SCHEMA FINDINGS (see also the W1-POL SEAMS report):
 *  - `products.lowStockThreshold` IS a genuinely nullable raw column (its DB default
 *    was dropped by migration 20260711000000; legacy `10`s were backfilled to NULL) —
 *    NULL cleanly means "inherit". Raw-based source works exactly as specified.
 *  - `product_reorder_configs.leadTimeDays` / `.customSafetyStockDays` /
 *    `.reorderPointOverride` are nullable raws (NULL = inherit / unset). But
 *    `product_reorder_configs.minOrderQuantity` is declared `Int @default(1)` — it is
 *    NOT nullable at the DB level, so once ANY reorder-config row exists for a product
 *    (created because some OTHER field was overridden), `minOrderQuantity` always reads
 *    a concrete integer and can never itself represent "inherited" at the column level.
 *    This module treats ROW ABSENCE (no `product_reorder_configs` row at all) as the
 *    only representable "raw = null / system_default" state for `minOrderQuantity`;
 *    once a row exists, `minOrderQuantity` is `"product_override"` even if its stored
 *    value is the untouched default of 1. This is a real schema limitation, not a bug
 *    in this module — documented per the module brief's instruction to surface it
 *    rather than invent a sentinel.
 *  - `product_locations.minQuantity` (`Int @default(0)`, "0 disables the trigger") IS
 *    the per-location minimum the plan's `locationMinimums` field needs — no schema gap
 *    here. Only rows with `minQuantity > 0` are returned (spec §5 T-POL: "per-location
 *    minQuantity if set"; 0 is the disabled/unset state, mirroring the threshold
 *    convention, not an active minimum).
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import type { GlobalReorderSettings } from "@prisma/client";
import { getGlobalReorderSettings, resolveReorderConfig } from "@/lib/reorder-config";
import { getLowStockDefault, effectiveLowStockThreshold } from "@/lib/stock-threshold";
import { resolveAssistantProduct } from "@/lib/assistant/resolve-product";

/**
 * A single policy field carrying BOTH the effective (resolved) value and the raw
 * stored value, plus a source label derived strictly from raw-column presence.
 * `"location_override"` is reserved by the plan contract for a future per-location
 * field source; no field produced by this module currently emits it (see SEAMS).
 */
export interface PolicyField<T> {
  effective: T;
  raw: T | null;
  source: "product_override" | "system_default" | "location_override";
}

export interface ProductPolicy {
  productId: number;
  name: string | null;
  lowStockThreshold: PolicyField<number>;
  leadTimeDays: PolicyField<number>;
  safetyStockDays: PolicyField<number>;
  minOrderQuantity: PolicyField<number | null>;
  reorderPointOverride: number | null;
  locationMinimums: Array<{ locationId: number; minQuantity: number }>;
}

export interface GlobalPolicy {
  lowStockDefault: number;
  reorder: GlobalReorderSettings;
  minEvidenceEvents: number;
}

/** Raw-column presence decides the source — NEVER equality with the default. */
function sourceFromRaw(raw: unknown): "product_override" | "system_default" {
  return raw !== null && raw !== undefined ? "product_override" : "system_default";
}

/**
 * Read the inventory policy: global defaults always, plus (when `productId` is given
 * and resolves to an approved, non-deleted product) that product's raw overrides,
 * effective values, and per-field source. Read-only — issues zero writes.
 */
export async function getPolicy(opts: {
  productId?: number;
}): Promise<{ global: GlobalPolicy; product?: ProductPolicy }> {
  const [lowStockDefault, globalReorder] = await Promise.all([
    getLowStockDefault(),
    getGlobalReorderSettings(),
  ]);

  // Global-only resolution (product: null) reuses resolveReorderConfig's own
  // clamping/fallback rules for minEvidenceEvents rather than re-deriving them here.
  const globalResolved = resolveReorderConfig(null, globalReorder);

  const global: GlobalPolicy = {
    lowStockDefault,
    reorder: globalReorder,
    minEvidenceEvents: globalResolved.minEvidenceEvents,
  };

  if (opts.productId == null) {
    return { global };
  }

  const resolved = await resolveAssistantProduct(opts.productId);
  if (!resolved) {
    // Unknown / pending-review / soft-deleted product: global-only. The tool layer
    // (W1-INT) is responsible for surfacing notFound("product", id) in this case.
    return { global };
  }

  const product = await prisma.product.findUnique({
    where: { id: resolved.id },
    select: {
      id: true,
      name: true,
      lowStockThreshold: true,
      reorderConfig: {
        select: {
          leadTimeDays: true,
          customSafetyStockDays: true,
          minOrderQuantity: true,
          reorderPointOverride: true,
        },
      },
    },
  });

  if (!product) {
    // Vanishingly rare race: resolveAssistantProduct just confirmed the row, but
    // treat a disappearance the same way as "unknown" rather than throwing.
    return { global };
  }

  const productReorder = resolveReorderConfig(product.reorderConfig ?? null, globalReorder);

  const rawLowStock = product.lowStockThreshold;
  const rawLeadTime = product.reorderConfig?.leadTimeDays ?? null;
  const rawSafetyStock = product.reorderConfig?.customSafetyStockDays ?? null;
  // Row-presence-based: the column itself cannot store NULL once a row exists (see
  // the module-header SCHEMA FINDINGS note on product_reorder_configs.minOrderQuantity).
  const rawMinOrderQuantity = product.reorderConfig ? product.reorderConfig.minOrderQuantity : null;

  const locationRows = await prisma.product_locations.findMany({
    where: { productId: resolved.id, minQuantity: { gt: 0 } },
    select: { locationId: true, minQuantity: true },
    orderBy: { locationId: "asc" },
  });

  const productPolicy: ProductPolicy = {
    productId: product.id,
    name: product.name,
    lowStockThreshold: {
      effective: effectiveLowStockThreshold(rawLowStock, lowStockDefault),
      raw: rawLowStock,
      source: sourceFromRaw(rawLowStock),
    },
    leadTimeDays: {
      effective: productReorder.leadTimeDays,
      raw: rawLeadTime,
      source: sourceFromRaw(rawLeadTime),
    },
    safetyStockDays: {
      effective: productReorder.bufferDays,
      raw: rawSafetyStock,
      source: sourceFromRaw(rawSafetyStock),
    },
    minOrderQuantity: {
      effective: productReorder.minOrderQuantity,
      raw: rawMinOrderQuantity,
      source: sourceFromRaw(rawMinOrderQuantity),
    },
    reorderPointOverride: productReorder.reorderPointOverride,
    locationMinimums: locationRows.map((row) => ({
      locationId: row.locationId,
      minQuantity: row.minQuantity,
    })),
  };

  return { global, product: productPolicy };
}
