/**
 * mcp/src/health.ts — the sidecar's unauthenticated /healthz probe (spec D8/D12).
 *
 * Reports:
 *   - encryptionKey: the shared shape probe (encryptionKeyReadiness). Reads do NOT
 *     need the key (only provider-credential decryption does) so it is REPORTED,
 *     never gating — "report, don't die" (readiness.ts contract).
 *   - db: a cheap `SELECT 1` liveness probe.
 * Top-level `ok` reflects DB reachability only — the thing the read-only sidecar
 * actually needs to serve traffic. The container HEALTHCHECK maps ok -> 200/503.
 *
 * MUST stay Next-free.
 */

import { encryptionKeyReadiness } from "@/lib/assistant/readiness";

export interface HealthReport {
  ok: boolean;
  encryptionKey: { ok: boolean; reason?: string };
  db: { ok: boolean; reason?: string };
}

/** A minimal structural view of the Prisma client so this stays trivially testable. */
export interface DbProbe {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

export async function healthReport(db: DbProbe): Promise<HealthReport> {
  const encryptionKey = encryptionKeyReadiness();

  let dbState: { ok: boolean; reason?: string };
  try {
    await db.$queryRaw`SELECT 1`;
    dbState = { ok: true };
  } catch {
    dbState = { ok: false, reason: "database unreachable" };
  }

  return { ok: dbState.ok, encryptionKey, db: dbState };
}
