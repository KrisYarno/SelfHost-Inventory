#!/usr/bin/env node
const intervalMinutes = parseInt(process.env.EXTERNAL_SYNC_INTERVAL_MINUTES || "15", 10);
const lookbackDays = parseInt(process.env.EXTERNAL_SYNC_LOOKBACK_DAYS || "1", 10);
const maxOrders = parseInt(process.env.EXTERNAL_SYNC_MAX_ORDERS || "250", 10);
const syncUrl = process.env.INTERNAL_SYNC_URL || "http://app:3000/api/cron/external-sync";
const syncToken = process.env.INTERNAL_SYNC_TOKEN || "";

async function runOnce() {
  if (!syncToken) {
    console.error("[sync] INTERNAL_SYNC_TOKEN is not set. Skipping run.");
    return;
  }

  let resp;
  try {
    resp = await fetch(syncUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-sync-token": syncToken,
      },
      body: JSON.stringify({ lookbackDays, maxOrders }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync] Request failed: ${message}`);
    return;
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    console.error(`[sync] HTTP ${resp.status}: ${bodyText.slice(0, 500)}`);
    return;
  }

  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    console.error("[sync] Failed to parse response JSON.");
    return;
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length === 0) {
    console.log("[sync] No active integrations found.");
    return;
  }

  for (const result of results) {
    if (result?.error) {
      console.error(`[sync] ${result.name || result.integrationId} failed: ${result.error}`);
      continue;
    }

    console.log(
      `[sync] ${result.name || result.integrationId} (${result.platform}): fetched ${result.fetched}, updated ${result.upserted}, skipped ${result.skipped}`
    );
  }
}

async function main() {
  const enabled = process.env.ENABLE_EXTERNAL_SYNC === "1";
  if (!enabled) {
    console.log("[sync] External sync disabled (ENABLE_EXTERNAL_SYNC=1 to enable).");
    process.exit(0);
  }

  console.log(
    `[sync] Starting scheduled sync: interval ${intervalMinutes}m, lookback ${lookbackDays}d, maxOrders ${maxOrders}`
  );

  await runOnce();

  setInterval(async () => {
    await runOnce();
  }, Math.max(1, intervalMinutes) * 60 * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
