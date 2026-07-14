/**
 * BYPASS FIXTURE 3 of 3 — dynamic import + aliased fetch.
 *
 * Two evasions in one: resolve fetch through a dynamic `import()` (so a static
 * import-scan can't see it) and call it through a local alias (so a
 * `globalThis.fetch(` text scan can't see it either). Both the interceptor
 * (LAYER A, runtime) and the import-boundary rule (LAYER B) must still catch it.
 *
 * Invoked only by lane6-egress-enforcement.test.ts, which asserts it FAILS with
 * the sentinel.
 */

export async function attemptBypass(): Promise<void> {
  // Alias the global so no `globalThis.fetch(` / `global.fetch(` token appears.
  const f: typeof fetch = (globalThis as { fetch: typeof fetch }).fetch;

  await f("https://awake-store.myshopify.com/admin/api/2025-10/orders.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: { id: 1 } }),
  });
}
