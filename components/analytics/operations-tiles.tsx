"use client";

import type { OperationsRow, ShrinkageSummary, ValuationSummary } from "@/lib/analytics/queries";

export interface OperationsTilesData {
  rows: OperationsRow[];
  shrinkage90: ShrinkageSummary;
  valuation: ValuationSummary;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
// Lane 6 (B2): a null cost figure is "no cost data on file", not "$0.00".
const money = (cents: number | null) => (cents === null ? "No cost data" : usd.format(cents / 100));
const numberFmt = new Intl.NumberFormat("en-US");

// One summary tile. Flat surface + divider hierarchy (D-L7): bg-surface, no
// shadowed Card stack. The metric uses the registered `metric-lg` type token.
function Tile({
  label,
  value,
  caption,
  captionTitle,
  muted,
}: {
  label: string;
  value: string;
  caption?: string;
  captionTitle?: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-body-sm text-muted-foreground">{label}</div>
      <div
        className={
          muted
            ? "mt-1 text-metric-lg tabular-nums text-muted-foreground"
            : "mt-1 text-metric-lg tabular-nums text-foreground"
        }
      >
        {value}
      </div>
      {caption && (
        <div className="mt-1 text-body-sm text-muted-foreground" title={captionTitle}>
          {caption}
        </div>
      )}
    </div>
  );
}

// The four Operations summary tiles (D-L3): inventory value at current cost /
// blended turns / 90d shrinkage / aging outliers. All figures derive from the
// single Operations payload; each carries its own honest caption.
export function OperationsTiles({ data }: { data: OperationsTilesData }) {
  const { rows, shrinkage90, valuation } = data;

  const turnsVals = rows
    .map((r) => r.turns90)
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const blendedTurns =
    turnsVals.length > 0 ? turnsVals.reduce((a, b) => a + b, 0) / turnsVals.length : null;

  // Classified loss only (Lane 6 / B1): damage, theft, expiry, count. Unclassified
  // outbound (the negative ADJUSTMENTs this business ships with) is a coverage note,
  // never bucketed as shrinkage.
  const shrinkUnits = shrinkage90.totalUnits;
  const shrinkValue = shrinkage90.totalValueAtCurrentCostCents;
  const unclassified = shrinkage90.coverage.unclassifiedOutboundUnits;

  const agingOutliers = rows.filter((r) => r.attention === "stale").length;

  const costCov = valuation.costCoverage;
  const receiptCov = valuation.receiptCoverage;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile
        label="Inventory value"
        value={money(valuation.atCurrentCostCents)}
        muted={valuation.atCurrentCostCents === null}
        caption={`Cost on file for ${costCov.valued} of ${costCov.of} · receipt cost for ${receiptCov.have} of ${receiptCov.of}`}
        captionTitle="Valued at each product's current cost price, over products with a cost on file. No cost on file means the value is not shown rather than counted as $0.00."
      />
      <Tile
        label="Blended turns (90 days)"
        value={blendedTurns === null ? "—" : `${blendedTurns.toFixed(1)}x`}
        muted={blendedTurns === null}
        caption={
          blendedTurns === null
            ? "Awaiting fulfilled orders and stock snapshots"
            : `Averaged across ${turnsVals.length} product${turnsVals.length === 1 ? "" : "s"}`
        }
      />
      <Tile
        label="Shrinkage (90 days)"
        value={numberFmt.format(shrinkUnits)}
        caption={
          unclassified > 0
            ? `${money(shrinkValue)} · classified loss only. ${numberFmt.format(
                unclassified,
              )} outbound units carry no reason code and are not counted as loss.`
            : `${money(shrinkValue)} · damage, theft, expiry, count`
        }
      />
      <Tile
        label="Aging outliers"
        value={numberFmt.format(agingOutliers)}
        caption="In stock, no outbound movement over 90 days"
      />
    </div>
  );
}
