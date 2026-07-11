/**
 * F3 product-analytics — the SELF-HOSTED SCHEDULED ENTRYPOINT.
 *
 * This stack is self-hosted via SFTP, NOT Vercel, so vercel.json crons are inert.
 * The real scheduled trigger for the materialized analytics layer is THIS script,
 * invoked by host cron or a Docker sidecar. The HTTP route
 * (app/api/cron/analytics-rebuild/route.ts) handles only nightly-size manual
 * triggers; the weekly TRUE-FULL sales rebuild lives HERE because it can exceed
 * HTTP request timeouts.
 *
 * RUN IT (tsx resolves the tsconfig `@/` path aliases the analytics libs use):
 *   npx tsx scripts/analytics-rebuild.ts --job sales     --mode nightly
 *   npx tsx scripts/analytics-rebuild.ts --job snapshots --mode nightly
 *   npx tsx scripts/analytics-rebuild.ts --job sales     --mode full
 *   npx tsx scripts/analytics-rebuild.ts --job snapshots --from 2026-01-01 --to 2026-01-31
 * Fallback runner (ts-node needs tsconfig-paths to resolve `@/`):
 *   npx ts-node -r tsconfig-paths/register scripts/analytics-rebuild.ts --job sales --mode nightly
 *
 * FLAGS:
 *   --job   snapshots | sales            (default: sales)
 *   --mode  nightly | full | backfill    (default: nightly)
 *   --from  YYYY-MM-DD                    (snapshots window start; sales since-date)
 *   --to    YYYY-MM-DD                    (snapshots window end)
 *
 * OUTPUT: a single JSON line of the lib result to stdout on success (exit 0),
 * suitable for cron logs; on failure a JSON `{ error }` line to stderr (exit 1).
 *
 * OPS — wire into host cron or a Docker sidecar (the stack already runs a
 * mysql-cron-backup sidecar as precedent). Example crontab (UTC):
 *
 *   # nightly 03:10 UTC: sales (updatedAt window) + snapshots (today + backfill)
 *   10 3 * * *  cd /app && npx tsx scripts/analytics-rebuild.ts --job sales --mode nightly && npx tsx scripts/analytics-rebuild.ts --job snapshots --mode nightly
 *   # weekly Sun 04:00 UTC: true-full sales rebuild (reconciles late reversals)
 *   0 4 * * 0   cd /app && npx tsx scripts/analytics-rebuild.ts --job sales --mode full
 *
 * Both rebuild fns take a cross-process lock + heartbeat, so overlapping runs
 * (cron vs the HTTP route) are safe — a contended run simply no-ops.
 */

import { rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";

export type Job = "snapshots" | "sales";
export type Mode = "nightly" | "full" | "backfill";

export interface ParsedArgs {
  job: Job;
  mode: Mode;
  from?: string;
  to?: string;
}

/** Pure argv parser (no dependency). `argv` is the slice AFTER `node script.ts`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };

  const job: Job = get("--job") === "snapshots" ? "snapshots" : "sales";

  const rawMode = get("--mode");
  const mode: Mode =
    rawMode === "full" || rawMode === "backfill" || rawMode === "nightly"
      ? rawMode
      : "nightly";

  const from = get("--from");
  const to = get("--to");

  return { job, mode, from, to };
}

/** Run the requested rebuild and return the lib result object. */
export async function runJob(args: ParsedArgs): Promise<unknown> {
  // Every CLI invocation is telemetered as source:'cli' with the requested mode.
  const meta = { mode: args.mode, source: "cli" as const };

  if (args.job === "snapshots") {
    // snapshots: explicit window if given, else default (today + per-pair backfill).
    return rebuildStockSnapshots({ from: args.from, to: args.to, meta });
  }

  // sales:
  //   full        => true-full rebuild (every dayKey; reconciles late reversals)
  //   --from given => since = start of that UTC day
  //   nightly     => lib default (~36h updatedAt window)
  if (args.mode === "full") {
    return rebuildSalesFacts({ full: true, meta });
  }
  if (args.from) {
    return rebuildSalesFacts({ since: new Date(`${args.from}T00:00:00Z`), meta });
  }
  return rebuildSalesFacts({ meta });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runJob(args);
  // single JSON line for cron logs
  process.stdout.write(JSON.stringify({ ok: true, ...args, result }) + "\n");
  process.exit(0);
}

// Only auto-run when executed directly (not when imported by a unit test).
if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.exit(1);
  });
}
