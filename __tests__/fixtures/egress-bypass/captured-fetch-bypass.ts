/**
 * BYPASS FIXTURE 1 of 3 — captured-original fetch.
 *
 * The subtlest real-world bypass: capture a reference to fetch BEFORE any guard
 * could wrap it, then call the captured reference later. A stack-based
 * interceptor might miss it; the mark-based interceptor does not, because the
 * captured function is still the guarded accessor (there is nothing else to
 * capture — the property is non-configurable).
 *
 * This file is NOT part of the normal suite. It is invoked only by
 * lane6-egress-enforcement.test.ts, which asserts it FAILS with the sentinel.
 * A version that sneaks through is a plan failure, not a curiosity.
 */

const capturedFetch = globalThis.fetch;

export async function attemptBypass(): Promise<void> {
  // Reach a WooCommerce REST endpoint directly, with a write method, from a file
  // that is NOT under lib/platforms/egress. The interceptor must stop this.
  await capturedFetch("https://store.example.com/wp-json/wc/v3/orders/555", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
}
