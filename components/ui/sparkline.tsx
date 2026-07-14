import dynamic from "next/dynamic";
import type { SparklineProps } from "./sparkline-impl";

// P1 (Lane 5): recharts is loaded lazily and client-only so it never chains
// into the initial JS of the routes that render a sparkline. The heavy recharts
// implementation lives in ./sparkline-impl; this module is the thin public
// wrapper every consumer imports (their imports are untouched).
const SparklineImpl = dynamic(() => import("./sparkline-impl"), {
  ssr: false,
  loading: () => <div aria-hidden className="h-8 w-full animate-pulse rounded bg-surface" />,
});

export function Sparkline(props: SparklineProps) {
  return <SparklineImpl {...props} />;
}

export type { SparklineProps } from "./sparkline-impl";
