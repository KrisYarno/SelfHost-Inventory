/**
 * launch-gate/global-setup.ts — boot the harness (spec C7; plan Task 1.5; D8).
 *
 * Order is contractual:
 *   preflight (docker + ports, FAIL CLOSED with an actionable message)
 *   -> throwaway mysql:8.4 container + `prisma migrate deploy` + the sentinel seed
 *   -> the D8 checksum BASELINE (captured before ANY test file runs, so the bracket
 *      is independent of jest's file ordering)
 *   -> shim + MCP + app, each polled to readiness
 *   -> WARM-UP: one throwaway pass over every route under test (OC-16).
 *
 * FAILURE SAFETY (G2P-5): a globalSetup rejection makes jest SKIP globalTeardown
 * entirely, so any failure here runs the shared idempotent `stopAll()` BEFORE
 * rethrowing. Without that, a container and three processes would survive a bad boot.
 */

import { loadChoreographies } from "./choreography";
import { startAll, stopAll } from "./spawn";
import { stateFilePath } from "./state";

export default async function globalSetup(): Promise<void> {
  const started = Date.now();
  // Fail before touching anything if the runner did not mint a state file, and
  // validate every committed scenario before a container exists to clean up.
  stateFilePath();
  loadChoreographies(`${__dirname}/choreography`);

  try {
    await startAll();
  } catch (err) {
    console.error("[launch-gate] setup failed — tearing the partial harness down");
    await stopAll();
    throw err;
  }
  console.log(`[launch-gate] harness ready in ${Math.round((Date.now() - started) / 1000)}s`);
}
