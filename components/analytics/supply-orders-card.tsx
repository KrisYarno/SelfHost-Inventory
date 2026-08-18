"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  useSupplyOrdersAnalytics,
  type SupplyOrderAnalyticsMetric,
} from "@/hooks/use-analytics";

/**
 * THE "SUPPLY ORDERS" CARD (contract pack C4b.5, spec §8, seam S18).
 *
 * Four numbers about money that left the building in the chosen window: the fees
 * paid to get the goods here, what suppliers failed to deliver, what the
 * labeling bench lost, and what arrived above the order.
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

const TILES: { key: keyof MetricSet; label: string }[] = [
  { key: "fees", label: "Order fees" },
  { key: "supplierShortageCost", label: "Supplier shortage (gross)" },
  { key: "labelingLossCost", label: "Labeling loss" },
  { key: "surplusValue", label: "Over-delivery surplus" },
];

type MetricSet = {
  fees: SupplyOrderAnalyticsMetric;
  supplierShortageCost: SupplyOrderAnalyticsMetric;
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
        {metric.valueCents === null ? "—" : usd.format(metric.valueCents / 100)}
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
      ) : isError || !data?.metrics || !data?.orders ? (
        // A body that does not carry the metric set is NOT data: rendering
        // tiles off it would invent numbers the server never sent.
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
