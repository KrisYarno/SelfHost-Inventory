/**
 * launch-gate/global-teardown.ts — the D8 bracket's closing half plus the ONE
 * idempotent cleanup (spec C7 row 6; plan D8 / G2P-5).
 *
 * ORDER MATTERS:
 *   1. compute the closing digests and compare them to the baseline — this needs the
 *      container ALIVE, so it happens FIRST;
 *   2. `stopAll()` in a `finally`, so a checksum failure still removes the container
 *      and the process tree;
 *   3. THEN rethrow the aggregated checksum/orphan failures. A globalTeardown
 *      rejection fails the run, which is what makes the bracket load-bearing rather
 *      than decorative.
 *
 * ZERO-BUSINESS-WRITES (row 6): every business table must be byte-identical across
 * the run. The only sanctioned movement is `api_tokens.lastUsedAt`, which the MCP
 * surface advances fire-and-forget on a READ — it is excluded from the digest, and
 * this file states positively whether it moved so the exemption can never quietly
 * cover a second column.
 */

import {
  apiTokensFullDigest,
  compareDigests,
  manifestDigests,
  readChecksumBaseline,
} from "./oracle";
import { findOrphans, stopAll } from "./spawn";

export default async function globalTeardown(): Promise<void> {
  const failures: string[] = [];

  try {
    const baseline = readChecksumBaseline();
    const after = await manifestDigests();
    const apiTokensAfter = await apiTokensFullDigest();
    const comparison = compareDigests(
      baseline.manifest,
      after,
      baseline.apiTokensFull,
      apiTokensAfter,
    );
    if (comparison.changedTables.length > 0) {
      failures.push(
        "ZERO-BUSINESS-WRITES VIOLATED — these manifest tables changed during the run: " +
          comparison.changedTables
            .map((table) => `${table} (${baseline.manifest[table]} -> ${after[table]})`)
            .join(", "),
      );
    } else {
      console.log(
        `[launch-gate] checksum bracket clean across ${Object.keys(after).length} business tables` +
          `${comparison.apiTokensLastUsedAtAdvanced ? " (api_tokens.lastUsedAt advanced — the one sanctioned delta)" : ""}`,
      );
    }
  } catch (err) {
    failures.push(
      `checksum verification could not complete: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await stopAll();
  }

  const orphans = await findOrphans();
  if (orphans.containers.length > 0) {
    failures.push(`teardown left containers behind: ${orphans.containers.join(", ")}`);
  }
  if (orphans.boundPorts.length > 0) {
    failures.push(`teardown left ports bound: ${orphans.boundPorts.join(", ")}`);
  }

  if (failures.length > 0) {
    throw new Error(`launch-gate teardown failed:\n - ${failures.join("\n - ")}`);
  }
}
