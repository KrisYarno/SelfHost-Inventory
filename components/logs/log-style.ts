"use client";

import { inventory_logs_logType } from "@prisma/client";
import { actionMeta, type ActionTone } from "@/lib/change-tracking/taxonomy";
import { toneClasses } from "@/components/ui/status-badge";

type Tone = {
  /** Semantic tone (Lane 3 D-L5). New/touched renderers pass this to StatusBadge. */
  tone: ActionTone;
  label: string;
  /**
   * Raw utility classes for LEGACY consumers still rendering a bare Badge.
   * New renderers use `tone` with StatusBadge/toneClasses instead.
   */
  className: string;
};

/**
 * Rebased onto the taxonomy contract (Lane 3 D3/R-L7): tone + human label come
 * from `actionMeta` (verb-derived tone, total over the 49-member union — no more
 * 18/49 hand-listed hex). `className` is the shared `toneClasses` vocabulary so
 * legacy Badge consumers stay D-L7-compliant until T4 converts them to
 * StatusBadge. Exported shape (`{ label, className }`) is preserved; `tone` is
 * additive.
 */
export function getAuditTone(actionType: string): Tone {
  const meta = actionMeta(actionType);
  return { tone: meta.tone, label: meta.label, className: toneClasses[meta.tone] };
}

/**
 * getInventoryLogTone gains a semantic `tone` (ActionTone) alongside its
 * existing `label`/`className` (codex #12). New/touched renderers pass `tone`
 * to StatusBadge; the raw-class `className` is UNCHANGED for the untouched
 * legacy consumers (admin ledger table, simple-inventory-log-table) until T4
 * converts them.
 */
export function getInventoryLogTone(logType: inventory_logs_logType | string, delta: number): Tone {
  switch (logType) {
    case "TRANSFER":
      return { tone: "neutral", label: "Transfer", className: "bg-slate-600 text-white" };
    case "STOCK_IN":
      return { tone: "positive", label: "Stock In", className: "bg-emerald-600 text-white" };
    case "SALE":
      return { tone: "info", label: "Sale", className: "bg-sky-600 text-white" };
    case "CORRECTION":
      return { tone: "warning", label: "Correction", className: "bg-amber-600 text-white" };
    case "COUNT":
      return { tone: "neutral", label: "Count", className: "bg-slate-500 text-white" };
    case "ADJUSTMENT":
      // Single canonical label — the delta column conveys direction (+/-), so a
      // positive ADJUSTMENT no longer mislabels itself "Stock In". Colour + tone
      // still track the sign for at-a-glance scanning.
      return delta >= 0
        ? { tone: "positive", label: "Adjustment", className: "bg-emerald-600 text-white" }
        : { tone: "negative", label: "Adjustment", className: "bg-rose-500 text-white" };
    default:
      return { tone: "neutral", label: String(logType), className: "bg-gray-600 text-white" };
  }
}
