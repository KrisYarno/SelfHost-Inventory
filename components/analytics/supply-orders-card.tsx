"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  useSupplyOrdersAnalytics,
  type SupplyOrderAnalyticsMetric,
} from "@/hooks/use-analytics";

/**
 * THE "SUPPLY ORDERS" CARD (contract pack C4b.5 + C5.4, spec §8 + D10, seam S18).
 *
 * The money that left the building in the chosen window: the fees paid to get
 * the goods here, what suppliers failed to deliver (GROSS, and NET of what they
 * made good), what the labeling bench lost, and what arrived above the order —
 * plus the RECEIPTS row, which answers a different question on a different
 * clock: what the dock actually stocked while this window was open.
 *
 * THE RULE THAT SHAPES EVERY TILE: `valueCents` is null EXACTLY when nothing
 * contributed (`contributingRows === 0`), and then the server sends a REASON.
 * A tile renders "—" plus that reason in that case and `$0.00` when rows did
 * contribute and summed to zero. "Nobody lost anything this month" and "we
 * cannot say what was lost" are different answers, and rendering both as $0.00
 * tells the reader the second is the first (SURVIVE-3).
 *
 * The DEFINITION and COVERAGE strings ride with each number rather than living
 * in a doc: the shortage figure is GROSS (credits and reshipments are not
 * subtracted), and a reader who cannot see that is being quietly misled about
 * what the number is.
 */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** The null rule in one place: "—" for unknown, real money for everything else. */
function amount(metric: SupplyOrderAnalyticsMetric): string {
  return metric.valueCents === null ? "—" : usd.format(metric.valueCents / 100);
}

/** "1 batch" / "5 batches" — a card that says "1 batches" reads as a rounding bug. */
function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}

const TILES: { key: keyof MetricSet; label: string }[] = [
  { key: "fees", label: "Order fees" },
  { key: "supplierShortageCost", label: "Supplier shortage (gross)" },
  // Two numbers off the SAME rows, so each label says which one it is: the net
  // moves whenever a credit note lands, months after the window closed (D10).
  { key: "supplierShortageCostNet", label: "Supplier shortage (net, as of now)" },
  { key: "labelingLossCost", label: "Labeling loss" },
  { key: "surplusValue", label: "Over-delivery surplus" },
];

type MetricSet = {
  fees: SupplyOrderAnalyticsMetric;
  supplierShortageCost: SupplyOrderAnalyticsMetric;
  supplierShortageCostNet: SupplyOrderAnalyticsMetric;
  labelingLossCost: SupplyOrderAnalyticsMetric;
  surplusValue: SupplyOrderAnalyticsMetric;
};

function MetricTile({
  name,
  label,
  metric,
}: {
  name: string;
  label: string;
  metric: SupplyOrderAnalyticsMetric;
}) {
  return (
    <div
      data-testid={`supply-orders-tile-${name}`}
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
    >
      <div className="text-body-sm text-muted-foreground">{label}</div>
      <div data-testid="tile-value" className="text-h3 tabular-nums text-foreground">
        {amount(metric)}
      </div>
      {metric.reason && (
        <p className="text-body-sm text-muted-foreground">{metric.reason}</p>
      )}
      <p className="text-body-sm text-muted-foreground">{metric.coverage}</p>
      <p className="text-body-sm text-muted-foreground">
        {`${metric.contributingRows} ${metric.contributingRows === 1 ? "row" : "rows"} contributed`}
      </p>
      <details>
        <summary className="cursor-pointer text-body-sm text-muted-foreground">
          What this counts
        </summary>
        <p className="mt-1 text-body-sm text-muted-foreground">{metric.definition}</p>
      </details>
    </div>
  );
}

export interface SupplyOrdersCardProps {
  /** The window's ends, as lexical calendar days (`YYYY-MM-DD`). */
  from: string;
  to: string;
}

export function SupplyOrdersCard({ from, to }: SupplyOrdersCardProps) {
  const { data, isLoading, isError, error } = useSupplyOrdersAnalytics({ from, to });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-h3 text-foreground">Supply orders</h3>
        <span className="text-body-sm text-muted-foreground">
          {`${from} to ${to} · by ordered date`}
        </span>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[...Array(4)].map((_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
      ) : isError || !data?.metrics || !data?.orders || !data?.receipts ? (
        // A body that does not carry the metric set is NOT data: rendering
        // tiles off it would invent numbers the server never sent. The receipts
        // block is held to the same rule (D10) — a missing roll-up is a broken
        // read, not a window in which nothing was stocked.
        <div
          data-testid="supply-orders-error"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-6 text-center text-sm text-destructive"
        >
          {error instanceof Error && error.message
            ? error.message
            : "Could not load the supply-order figures."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
            <span>{`${data.orders.count} ${data.orders.count === 1 ? "order" : "orders"} in the window`}</span>
            {Object.keys(data.orders.byStatus).length === 0 ? (
              <span>No orders were placed in this window.</span>
            ) : (
              Object.entries(data.orders.byStatus).map(([status, count]) => (
                <span
                  key={status}
                  className="rounded-full border border-border px-2 py-0.5 text-xs"
                >
                  {`${status} ${count}`}
                </span>
              ))
            )}
          </div>

          {/* The RECEIPTS roll-up (D10). Its own clock — the stock-in changeTime,
              not the ordered date the tiles above use — so it sits on its own row
              rather than pretending to be a fifth number about the same window
              basis. The grain rides as the row's title: five batches off one
              delivery is five events, and a reader who does not know that reads
              "5 batches" as five deliveries. */}
          <div
            data-testid="supply-orders-receipts"
            title={data.receipts.definition}
            className="space-y-1 rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
              <span className="text-foreground">Received in this window</span>
              <span>{count(data.receipts.orders, "order")}</span>
              <span aria-hidden="true">·</span>
              <span>{count(data.receipts.linesVerified, "line")}</span>
              <span aria-hidden="true">·</span>
              <span>{count(data.receipts.batches, "batch", "batches")}</span>
              <span aria-hidden="true">·</span>
              <span>{count(data.receipts.unitsStocked, "unit")}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {`receipt cost ${amount(data.receipts.receiptCostCents)}`}
              </span>
            </div>
            {data.receipts.receiptCostCents.reason && (
              <p className="text-body-sm text-muted-foreground">
                {data.receipts.receiptCostCents.reason}
              </p>
            )}
            <p className="text-body-sm text-muted-foreground">
              {data.receipts.receiptCostCents.coverage}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {TILES.map(({ key, label }) => (
              <MetricTile
                key={key}
                name={key}
                label={label}
                metric={data.metrics[key]}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
