/**
 * concurrency-gate/global-setup.ts — boot the harness (plan P-2; pack C7a.1).
 *
 * Order is contractual:
 *   fail closed unless the runner minted a state file
 *   -> throwaway mysql:8.4 container + `prisma migrate deploy`
 *   -> the fixture seed.
 *
 * FAILURE SAFETY (G2P-5): a globalSetup rejection makes jest SKIP globalTeardown
 * entirely, so any failure here tears the partial harness down BEFORE rethrowing.
 * Without that, a container and its data volume would survive a bad boot.
 *
 * RELATIVE IMPORTS ONLY: jest loads globalSetup through `requireOrImportModule`,
 * which applies the transform but NOT `moduleNameMapper` — an `@/...` value
 * import anywhere in this graph fails to resolve at boot (launch-gate/seed.ts:23-27).
 */

import { bootDatabase, stopDatabase } from "./db";
import { seedGateDatabase } from "./seed";
import { stateFilePath } from "./state";

export default async function globalSetup(): Promise<void> {
  const started = Date.now();
  stateFilePath();

  try {
    const databaseUrl = await bootDatabase();
    await seedGateDatabase(databaseUrl);
  } catch (err) {
    console.error("[concurrency-gate] setup failed — tearing the partial harness down");
    try {
      await stopDatabase();
    } catch (teardownErr) {
      // Never mask the real cause; state both.
      console.error("[concurrency-gate] teardown after a failed setup ALSO failed", teardownErr);
    }
    throw err;
  }
  console.log(
    `[concurrency-gate] harness ready in ${Math.round((Date.now() - started) / 1000)}s`,
  );
}
