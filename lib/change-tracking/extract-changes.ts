/**
 * lib/change-tracking/extract-changes.ts — the R-L7 legacy-diff adapter
 * (Lane 3 spec §10 R-L7, codex #10).
 *
 * Renderers (`components/history/*`) only ever see the CANONICAL field-diff
 * shape `{ field: { from, to } }`. Historical `audit_logs.details` payloads
 * carry that diff in two known places:
 *
 *   1. Foundation shape (current `recordChange`): `details.changes` is the diff,
 *      alongside `details.actor` (envelope) and any writer-supplied keys.
 *   2. Pre-foundation product-update shape (retired `lib/audit.ts`
 *      `logProductUpdate`): `details = { productName, changes }` — same nested
 *      `changes` diff under a different envelope.
 *
 * Both surface the diff at `details.changes`. This adapter normalizes both,
 * drops entries that are not a `{ from, to }` pair (so a corrupt row can't crash
 * a renderer), and returns null for absent / malformed / empty details.
 * `[REDACTED]` values pass through verbatim — they are the truthful value.
 */

export type ChangePair = { from: unknown; to: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A change entry is renderable iff it is a plain object exposing both keys. */
function isChangePair(value: unknown): value is ChangePair {
  return isPlainObject(value) && 'from' in value && 'to' in value;
}

/**
 * Normalize any historical `details` payload to the canonical field-diff, or
 * null. Never throws.
 */
export function extractChanges(details: unknown): Record<string, ChangePair> | null {
  if (!isPlainObject(details)) return null;

  const raw = (details as Record<string, unknown>).changes;
  if (!isPlainObject(raw)) return null;

  const out: Record<string, ChangePair> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (isChangePair(value)) {
      out[field] = { from: value.from, to: value.to };
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}
