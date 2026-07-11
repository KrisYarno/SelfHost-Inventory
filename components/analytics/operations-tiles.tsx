"use client";

import type { OperationsRow, ShrinkageReason } from "@/lib/analytics/queries";

type ShrinkageByReason = Record<
  ShrinkageReason,
  { units: number; valueAtCurrentCostCents: number | null }
>;

export interface OperationsTilesData {
  rows: OperationsRow[];
  shrinkage90: { byReason: ShrinkageByReason };
  valuation: {
    atCurrentCostCents: number;
    atReceiptCostCents: number | null;
    receiptCoverage: { have: number; of: number };
  };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (cents: number) => usd.format(cents / 100);
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

  const sh = shrinkage90.byReason;
  const shrinkUnits = sh.DAMAGE.units + sh.THEFT.units + sh.EXPIRY.units;
  const shrinkValue =
    (sh.DAMAGE.valueAtCurrentCostCents ?? 0) +
    (sh.THEFT.valueAtCurrentCostCents ?? 0) +
    (sh.EXPIRY.valueAtCurrentCostCents ?? 0);

  const agingOutliers = rows.filter((r) => r.attention === "stale").length;

  const cov = valuation.receiptCoverage;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile
        label="Inventory value"
        value={money(valuation.atCurrentCostCents)}
        caption={`At current cost · receipt cost for ${cov.have} of ${cov.of}`}
        captionTitle="Valued at each product's current cost price. The receipt-cost figure covers only products with a recorded stock-in cost."
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
        caption={`${money(shrinkValue)} at current cost · damage, theft, expiry`}
      />
      <Tile
        label="Aging outliers"
        value={numberFmt.format(agingOutliers)}
        caption="In stock, no outbound movement over 90 days"
      />
    </div>
  );
}
