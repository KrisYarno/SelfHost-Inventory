/**
 * lib/reorder-config.ts — the reorder-config inheritance/resolver (Lane
 * reorder-points, Task 1).
 *
 * ADOPTS the orphaned config schema (global_reorder_settings +
 * product_reorder_configs) into a typed, testable resolver. The inheritance model
 * MIRRORS the shape of stock-threshold.ts (per-product override -> global default)
 * but is DELIBERATELY DIFFERENT on one axis (codex #11): lead time has NO "disabled"
 * semantic. Unlike a threshold where 0 = alerts off, a lead time is ALWAYS a positive
 * number — a 0/negative/absurd stored value coerces to the default WITH a source label
 * so the surface can say "using the shop default". The flat policy BUFFER, by contrast,
 * legitimately can be 0 (no buffer) and must NOT coerce.
 *
 * MUST stay Next-free (imported by the report + assistant-tool layers): no `next/*`,
 * no `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { GlobalReorderSettings } from "@prisma/client";

/** Hard fallback if even the global default lead time is misconfigured (<= 0). Mirrors
 *  warehouse-metrics DEFAULT_LEAD_TIME_DAYS so the two never diverge. */
export const DEFAULT_LEAD_TIME_DAYS = 14;

/**
 * The ONE authoritative in-memory fallback for the singleton global settings row
 * (spec §4 W0-RO / R2-B1). Full domain shape, mirroring the `@default(...)` tokens on
 * schema.prisma's `GlobalReorderSettings` model — the source of truth. Prisma does NOT
 * expose column defaults at runtime, so a schema-TEXT drift guard (in the reorder-config
 * unit test) parses those tokens and asserts they still match this constant.
 *
 * Used when the row is absent (a restored/pruned DB where the 20251204 seed was lost;
 * the 20260714220000 repair migration backfills it). Reading this constant is
 * SIDE-EFFECT-FREE: the read path issues ZERO writes.
 */
export const REORDER_GLOBAL_DEFAULTS: GlobalReorderSettings = {
  id: 1,
  defaultLeadTimeDays: 14,
  defaultSafetyStockDays: 7,
  defaultTargetCoverageMultiple: 2,
  minEvidenceEvents: 3,
  holdingCostRate: new Prisma.Decimal("0.25"),
  updatedBy: null,
  // Synthetic sentinel: the row is absent, so there is no real persisted timestamp.
  // The schema default is `now()` (a runtime function), which has no fixed value to
  // mirror; the epoch marks "these are the built-in defaults, never a saved state".
  updatedAt: new Date(0),
};

/** A stored lead time above this is treated as data corruption and coerced to the
 *  default (10 years — no legitimate procurement lead time approaches it). */
export const MAX_LEAD_TIME_DAYS = 3650;

export interface EffectiveReorderConfig {
  /** Always > 0. A 0/negative/absurd/NULL stored value resolves to the default. */
  leadTimeDays: number;
  leadTimeSource: "product" | "default";
  /** >= 0. An explicit 0 is a valid "no buffer" policy and is preserved. */
  bufferDays: number;
  bufferSource: "product" | "default";
  /** >= 1 (floored). */
  minOrderQuantity: number;
  /** >= 1 (floored). Global-only knob (D5). */
  targetCoverageMultiple: number;
  /** When set (>= 0), pins the reorder point; NULL = compute it. */
  reorderPointOverride: number | null;
  /** Min qualifying outbound events before a suggestion is made (>= 0). */
  minEvidenceEvents: number;
}

/** The subset of product_reorder_configs the resolver needs. */
export interface ProductReorderConfigInput {
  leadTimeDays: number | null;
  customSafetyStockDays: number | null;
  minOrderQuantity: number | null;
  reorderPointOverride: number | null;
}

function isPositiveInt(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Read the singleton global settings row (id = 1). READ-ONLY (spec §4 W0-RO / R2-B1):
 * a plain `findUnique` with an in-memory fallback to `REORDER_GLOBAL_DEFAULTS` when the
 * row is absent. This path is reachable from the assistant/MCP `reorder_report` tool, so
 * it MUST NOT write — the earlier `upsert` (which seeded the row on every read) was the
 * R2-B1 blocker. The only authorized seed is the admin PUT's upsert and the
 * 20260714220000 repair migration.
 */
export async function getGlobalReorderSettings(): Promise<GlobalReorderSettings> {
  const row = await prisma.globalReorderSettings.findUnique({ where: { id: 1 } });
  return row ?? REORDER_GLOBAL_DEFAULTS;
}

/**
 * Resolve a product's effective reorder config from its (nullable) per-product row
 * plus the global defaults. Pure — no I/O — so callers batch the two reads once and
 * map over the products.
 */
export function resolveReorderConfig(
  product: ProductReorderConfigInput | null,
  globals: GlobalReorderSettings,
): EffectiveReorderConfig {
  // Lead time: ALWAYS positive. The global default is itself guarded so a corrupt
  // settings row can never yield a 0 lead time downstream.
  const globalLead = isPositiveInt(globals.defaultLeadTimeDays)
    ? globals.defaultLeadTimeDays
    : DEFAULT_LEAD_TIME_DAYS;

  let leadTimeDays: number;
  let leadTimeSource: "product" | "default";
  const pLead = product?.leadTimeDays;
  if (isPositiveInt(pLead) && pLead <= MAX_LEAD_TIME_DAYS) {
    leadTimeDays = pLead;
    leadTimeSource = "product";
  } else {
    leadTimeDays = globalLead;
    leadTimeSource = "default";
  }

  // Buffer days: 0 is a VALID policy (no buffer) and is preserved. Only NULL (inherit)
  // or a negative (invalid) value falls back to the global default.
  const globalBuffer = Math.max(0, globals.defaultSafetyStockDays ?? 7);
  let bufferDays: number;
  let bufferSource: "product" | "default";
  const pBuffer = product?.customSafetyStockDays;
  if (typeof pBuffer === "number" && Number.isFinite(pBuffer) && pBuffer >= 0) {
    bufferDays = pBuffer;
    bufferSource = "product";
  } else {
    bufferDays = globalBuffer;
    bufferSource = "default";
  }

  const minOrderQuantity = isPositiveInt(product?.minOrderQuantity)
    ? (product!.minOrderQuantity as number)
    : 1;

  const targetCoverageMultiple = isPositiveInt(globals.defaultTargetCoverageMultiple)
    ? globals.defaultTargetCoverageMultiple
    : 1;

  const pOverride = product?.reorderPointOverride;
  const reorderPointOverride =
    typeof pOverride === "number" && Number.isFinite(pOverride) && pOverride >= 0
      ? pOverride
      : null;

  const minEvidenceEvents =
    typeof globals.minEvidenceEvents === "number" && globals.minEvidenceEvents >= 0
      ? globals.minEvidenceEvents
      : 3;

  return {
    leadTimeDays,
    leadTimeSource,
    bufferDays,
    bufferSource,
    minOrderQuantity,
    targetCoverageMultiple,
    reorderPointOverride,
    minEvidenceEvents,
  };
}
