import dynamic from "next/dynamic";

// P1 (Lane 5): the recharts implementations live in ./inventory-chart-impl and
// are loaded lazily + client-only, so recharts never chains into the initial JS
// of /admin/reports or /analytics/product/[id]. Each public export is a
// next/dynamic wrapper around one named impl export; consumers import the same
// names as before and are untouched.

const ChartSkeleton = () => (
  <div aria-hidden className="h-[360px] w-full animate-pulse rounded-lg bg-surface" />
);

export const LineChartComponent = dynamic(
  () => import("./inventory-chart-impl").then((m) => m.LineChartComponent),
  { ssr: false, loading: ChartSkeleton },
);

export const BarChartComponent = dynamic(
  () => import("./inventory-chart-impl").then((m) => m.BarChartComponent),
  { ssr: false, loading: ChartSkeleton },
);

export const PieChartComponent = dynamic(
  () => import("./inventory-chart-impl").then((m) => m.PieChartComponent),
  { ssr: false, loading: ChartSkeleton },
);

export const ActivityBarChart = dynamic(
  () => import("./inventory-chart-impl").then((m) => m.ActivityBarChart),
  { ssr: false, loading: ChartSkeleton },
);

export type { ChartProps } from "./inventory-chart-impl";
