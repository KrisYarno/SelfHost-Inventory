import { timingSafeEqual } from "node:crypto";

// Timing-safe secret comparison primitives (Lane 5 S1). Next-free (node:crypto only) so
// they can be adopted by cron routes, external-sync, and any future secret check without
// pulling in Next request types. The source-scan gate
// (__tests__/integration/lane5-secret-scan-gate.test.ts) enforces that every CRON_SECRET /
// INTERNAL_SYNC_TOKEN comparison in app/api routes goes through these helpers.

/**
 * Constant-time string equality. Length mismatch returns false immediately (length is not
 * secret); equal-length inputs are compared with crypto.timingSafeEqual over their utf8 bytes.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * True only when `authorizationHeader` is exactly `Bearer <secret>`. Returns false when the
 * secret is unset/empty or the header is missing or does not carry the exact `Bearer ` prefix.
 * The token comparison itself is timing-safe; the fixed prefix is public and matched plainly.
 */
export function bearerAuthorized(
  authorizationHeader: string | null,
  secret: string | undefined
): boolean {
  if (!secret) return false;
  if (!authorizationHeader) return false;
  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) return false;
  const token = authorizationHeader.slice(prefix.length);
  return timingSafeStringEqual(token, secret);
}

/**
 * Raw-header variant for schemes that carry the secret directly in a custom header
 * (external-sync's `x-internal-sync-token`). Returns false when the secret is unset/empty or
 * the header is missing; otherwise a timing-safe comparison of the raw header value.
 */
export function headerTokenAuthorized(
  headerValue: string | null,
  secret: string | undefined
): boolean {
  if (!secret) return false;
  if (headerValue === null) return false;
  return timingSafeStringEqual(headerValue, secret);
}
