#!/usr/bin/env node
// Fulfillment-sync scheduler sidecar (Lane 6, L-WOO). Mirrors scripts/scheduled-external-sync.js:
// it only curls the app's own CRON_SECRET-gated route — it never talks to WooCommerce directly
// (all platform reads happen inside the app, through the egress read-only credential). Three
// cadences: incremental (fast), backfill (until done), reconcile (tombstones, daily).
const incrementalMinutes = parseInt(process.env.FULFILLMENT_INCREMENTAL_MINUTES || "10", 10);
const backfillMinutes = parseInt(process.env.FULFILLMENT_BACKFILL_MINUTES || "30", 10);
const reconcileHours = parseInt(process.env.FULFILLMENT_RECONCILE_HOURS || "24", 10);
const baseUrl = process.env.FULFILLMENT_SYNC_URL || "http://app:3000/api/cron/fulfillment-sync";
const secret = process.env.CRON_SECRET || "";

async function hit(mode, extraQuery) {
  if (!secret) {
    console.error("[fulfillment-sync] CRON_SECRET is not set. Skipping run.");
    return;
  }
  const url = extraQuery ? `${baseUrl}?mode=${mode}&${extraQuery}` : `${baseUrl}?mode=${mode}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await resp.text();
    if (!resp.ok) {
      console.error(`[fulfillment-sync] ${mode} HTTP ${resp.status}: ${body.slice(0, 300)}`);
      return;
    }
    console.log(`[fulfillment-sync] ${mode} ok: ${body.slice(0, 300)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fulfillment-sync] ${mode} request failed: ${message}`);
  }
}

async function main() {
  if (process.env.ENABLE_FULFILLMENT_SYNC !== "1") {
    console.log("[fulfillment-sync] disabled (set ENABLE_FULFILLMENT_SYNC=1 to enable). Idling.");
    process.exit(0);
  }
  console.log(
    `[fulfillment-sync] starting: incremental ${incrementalMinutes}m, backfill ${backfillMinutes}m, reconcile ${reconcileHours}h`
  );
  await hit("incremental");
  setInterval(() => hit("incremental"), Math.max(1, incrementalMinutes) * 60 * 1000);
  setInterval(() => hit("backfill", "maxPages=20"), Math.max(1, backfillMinutes) * 60 * 1000);
  setInterval(() => hit("reconcile"), Math.max(1, reconcileHours) * 60 * 60 * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
