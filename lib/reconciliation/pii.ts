/**
 * THE PII SOURCE for the reconciliation surface (spec REV-7 D6; pack C2a.3).
 *
 * Every read in this lane projects orders through ONE frozen select and users
 * through another, and the route-response harness
 * (__tests__/integration/reconciliation-pii.test.ts) walks each envelope this
 * lane serves against the forbidden-name set below. Two layers on purpose: the
 * select is what SHOULD reach the response, the assertion is what proves nothing
 * else did — a composite built by spreading some other producer's row cannot
 * pass the second layer just because this module's selects are correct.
 *
 * `note` IS NOT A FORBIDDEN NAME (CX-6). The Exceptions finder returns
 * `InventoryException.note` — an admin's own free text on an admin-only surface,
 * not order PII — and a generic forbidden-name set containing `note` would fail
 * every row the finder produces. The toolsuite gate keeps its own independent
 * literal (itself named `PII_FIELD_NAMES`) and pins that this set is a SUPERSET
 * of it, so narrowing here can never quietly weaken that gate.
 *
 * Next-free, Prisma-free, and textually write-free (pack R-4): this module is on
 * the assistant's read path.
 */

/**
 * Recursively freeze an allowlist so it cannot be widened at runtime — the
 * `lib/reports/order-pipeline.ts` idiom. A stray `SELECT.customerEmail = true`
 * throws in strict mode instead of silently changing the projection.
 *
 * EXPORTED for Part 2 (pack CA1.4): the order-items read the matcher stands on
 * freezes its own select the same way, and a second copy of this function would
 * be a second rule about what a select is.
 */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * The NINE names that must never appear as a key anywhere in a reconciliation
 * response — customer identity, verbatim platform payloads, and the outward
 * links that carry an order's identity with them.
 *
 * `variantName` is Part 2's addition (spec REV-8 §2.1): the order-items read
 * the matcher stands on projects the item row, and the per-customer variant
 * string is the one PII-shaped column on it. The reader never selects it; this
 * is the second layer that proves no composite put it back.
 */
export const RECONCILIATION_PII_FIELD_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    'customerEmail',
    'customerName',
    'rawPayload',
    'platformStatusRaw',
    'externalOrderUrl',
    'customerPhone',
    'shippingAddress',
    'billingAddress',
    'variantName',
  ])
);

/**
 * THE order projection for every reconciliation read. `companyId` is here for
 * the tool's membership math (whether the viewer may see the order at all) and
 * is STRIPPED from the output; the platform name arrives through the
 * integration relation because `external_orders` carries no `platform` column.
 *
 * The manual-attribution core additionally reads a two-column `{ id,
 * orderNumber }` locking projection — write path only (D6/CX-5).
 */
export const RECONCILIATION_ORDER_SELECT = deepFreeze({
  id: true,
  orderNumber: true,
  internalStatus: true,
  externalCreatedAt: true,
  companyId: true,
  integration: { select: { platform: true } },
} as const);

/**
 * THE user projection. An actor is a name and an id — never an email, never a
 * role, and never on a member-viewer read at all (D9: no actor identity).
 */
export const RECONCILIATION_USER_SELECT = deepFreeze({
  id: true,
  username: true,
} as const);

/**
 * Walk a JSON-shaped value and throw on the FIRST forbidden key, naming its
 * path. The path is what makes the failure actionable: "customerEmail leaked"
 * sends someone reading six producers, `rows[0].order.customerEmail` sends them
 * to one line.
 *
 * Key names only. A VALUE that happens to be an email is not what this catches —
 * the frozen selects are what keep the values out, and this is the second layer
 * that proves no composite widened the projection on the way to the wire.
 */
export function assertNoPiiKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoPiiKeys(item, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (RECONCILIATION_PII_FIELD_NAMES.has(key)) {
      throw new Error(`reconciliation response carries a forbidden field name at ${childPath}`);
    }
    assertNoPiiKeys(child, childPath);
  }
}
