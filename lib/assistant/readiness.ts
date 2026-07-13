/**
 * lib/assistant/readiness.ts — non-throwing startup readiness probes (spec D12,
 * codex #14).
 *
 * `ENCRYPTION_KEY` is validated LAZILY in lib/encryption (only when crypto runs).
 * This module gives app healthz + the MCP sidecar a SHAPE probe they can report on
 * WITHOUT throwing: healthz includes it; MCP startup logs it and CONTINUES (reads
 * do not need the key — only provider-credential decryption does; report, never die).
 *
 * MUST stay Next-free.
 */

const EXPECTED_KEY_BYTES = 32;

/**
 * Probe whether ENCRYPTION_KEY is present and correctly shaped (base64-decoding to
 * exactly 32 bytes — the AES-256 key length lib/encryption requires). Never throws;
 * returns `{ ok, reason? }`. `reason` is human-readable and free of the key value.
 */
export function encryptionKeyReadiness(): { ok: boolean; reason?: string } {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    return { ok: false, reason: "ENCRYPTION_KEY is not set (required for credential operations)" };
  }
  let byteLength: number;
  try {
    byteLength = Buffer.from(key, "base64").length;
  } catch {
    return { ok: false, reason: "ENCRYPTION_KEY must be a valid base64 string" };
  }
  if (byteLength !== EXPECTED_KEY_BYTES) {
    return {
      ok: false,
      reason: `ENCRYPTION_KEY must decode to ${EXPECTED_KEY_BYTES} bytes (got ${byteLength})`,
    };
  }
  return { ok: true };
}
