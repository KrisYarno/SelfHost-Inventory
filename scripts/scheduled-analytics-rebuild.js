#!/usr/bin/env node
//
// F3 product-analytics — the PROD SCHEDULED SIDECAR.
//
// This stack is self-hosted (SFTP, not Vercel), so vercel.json crons are inert.
// The real scheduled trigger is THIS long-running loop, run as a Docker sidecar
// (see the `analytics-rebuild` service in docker-compose.yml), mirroring the
// existing `sync` sidecar (scripts/scheduled-external-sync.js). It curls the
// INTERNAL app route http://app:3000/api/cron/analytics-rebuild with a
// Bearer CRON_SECRET. Because the internal hop has no cloudflared proxy in
// front of it, there is NO HTTP request timeout — so the weekly TRUE-FULL
// rebuild is safe over the route.
//
// CADENCE (UTC):
//   - nightly (every day, once, at/after ANALYTICS_NIGHTLY_HOUR_UTC):
//       sales nightly (~36h updatedAt window) + snapshots nightly (recent days)
//   - weekly full (on ANALYTICS_FULL_DOW at/after ANALYTICS_FULL_HOUR_UTC):
//       sales full (re-scan every dayKey) + snapshots full (history backfill)
//     The weekly full TAKES PRECEDENCE on its day and also satisfies that day's
//     nightly (so we don't run both on the full day).
//
// Job dedup is by an in-memory `state` ({ lastNightlyDay, lastFullWeek }). This
// is intentionally NOT persisted: if the sidecar restarts, it may re-run a job
// already done that day/week. That is HARMLESS — both rebuild fns take a
// cross-process lock + heartbeat and are idempotent, so a redundant run simply
// recomputes the same rows (or no-ops if contended).

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC calendar day 'YYYY-MM-DD'. toISOString() is always UTC. */
function dayKey(now) {
  return now.toISOString().slice(0, 10);
}

/** Stable monotonic weekly bucket (for dedup only — exact boundary irrelevant). */
function weekKey(now) {
  const utcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return String(Math.floor(utcMidnight / (7 * DAY_MS)));
}

/**
 * PURE scheduling decision. Given the current time, the last-run state, and the
 * cadence config, decide which jobs to fire and return the NEXT state.
 *
 * @param {Date} now
 * @param {{lastNightlyDay?: string, lastFullWeek?: string}} state
 * @param {{nightlyHourUtc:number, fullDow:number, fullHourUtc:number}} cfg
 * @returns {{jobs: {job:string, mode:string}[], state: {lastNightlyDay?:string, lastFullWeek?:string}}}
 */
function decideJobs(now, state, cfg) {
  const today = dayKey(now);
  const thisWeek = weekKey(now);

  // Weekly full takes precedence on its day/hour (and also covers today's nightly).
  if (
    now.getUTCDay() === cfg.fullDow &&
    now.getUTCHours() >= cfg.fullHourUtc &&
    state.lastFullWeek !== thisWeek
  ) {
    return {
      jobs: [
        { job: "sales", mode: "full" },
        { job: "snapshots", mode: "full" },
      ],
      // A full run also satisfies today's nightly — advance both markers.
      state: { ...state, lastFullWeek: thisWeek, lastNightlyDay: today },
    };
  }

  // Otherwise, the once-a-day nightly at/after the nightly hour.
  if (now.getUTCHours() >= cfg.nightlyHourUtc && state.lastNightlyDay !== today) {
    return {
      jobs: [
        { job: "sales", mode: "nightly" },
        { job: "snapshots", mode: "nightly" },
      ],
      state: { ...state, lastNightlyDay: today },
    };
  }

  // Nothing due — state unchanged.
  return { jobs: [], state };
}

async function runJob(url, secret, job, mode) {
  const target = `${url}?job=${job}&mode=${mode}`;
  let resp;
  try {
    resp = await fetch(target, {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Tolerate transient fetch errors — log and let the next tick retry.
    console.error(`[analytics-rebuild] ${job}/${mode} request failed: ${message}`);
    return;
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    console.error(
      `[analytics-rebuild] ${job}/${mode} HTTP ${resp.status}: ${bodyText.slice(0, 500)}`
    );
    return;
  }

  // Summarize the JSON body for the log (route returns { success, job, mode, result, ... }).
  let summary = bodyText.slice(0, 500);
  try {
    const payload = bodyText ? JSON.parse(bodyText) : null;
    if (payload && payload.skipped) {
      summary = `skipped (${payload.reason || "flag off"})`;
    } else if (payload && payload.result) {
      summary = JSON.stringify(payload.result);
    }
  } catch {
    /* keep raw slice */
  }
  console.log(`[analytics-rebuild] ${job}/${mode} ok: ${summary}`);
}

async function main() {
  const enabledRaw = process.env.ENABLE_ANALYTICS_REBUILD || "0";
  const enabled = enabledRaw === "1" || enabledRaw === "true";
  const url =
    process.env.ANALYTICS_REBUILD_URL ||
    "http://app:3000/api/cron/analytics-rebuild";
  const secret = process.env.CRON_SECRET || "";
  const tickMinutes = Math.max(
    1,
    parseInt(process.env.ANALYTICS_REBUILD_TICK_MINUTES || "30", 10)
  );
  const cfg = {
    nightlyHourUtc: parseInt(process.env.ANALYTICS_NIGHTLY_HOUR_UTC || "3", 10),
    fullDow: parseInt(process.env.ANALYTICS_FULL_DOW || "0", 10),
    fullHourUtc: parseInt(process.env.ANALYTICS_FULL_HOUR_UTC || "4", 10),
  };

  if (!enabled) {
    // Match the `sync` sidecar's gating posture: idle quietly rather than crash
    // the container, so the service can sit dormant until flipped on.
    console.log(
      "[analytics-rebuild] disabled (set ENABLE_ANALYTICS_REBUILD=1 to enable). Idling."
    );
    return;
  }

  console.log(
    `[analytics-rebuild] starting: tick ${tickMinutes}m, nightly ${cfg.nightlyHourUtc}:00 UTC, ` +
      `full DOW ${cfg.fullDow} ${cfg.fullHourUtc}:00 UTC, url ${url}`
  );

  // In-memory dedup state (see header: not persisted, restart-tolerant).
  const state = { lastNightlyDay: undefined, lastFullWeek: undefined };

  async function tick() {
    if (!secret) {
      console.error("[analytics-rebuild] CRON_SECRET is not set. Skipping run.");
      return;
    }
    const decision = decideJobs(new Date(), state, cfg);
    Object.assign(state, decision.state);
    if (decision.jobs.length === 0) return;
    for (const { job, mode } of decision.jobs) {
      await runJob(url, secret, job, mode);
    }
  }

  await tick();
  setInterval(tick, tickMinutes * 60 * 1000);
}

// Exports for unit tests (decideJobs is pure). Importing this file must NOT start
// the loop — only direct execution does (mirrors scripts/analytics-rebuild.ts).
module.exports = { decideJobs, dayKey, weekKey };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
