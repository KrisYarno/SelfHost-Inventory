/**
 * BYPASS FIXTURE 2 of 3 — node:https.get.
 *
 * axios is NOT installed in this repo (codex #18), so an axios fixture would
 * "pass" by failing module resolution — proving nothing. `node:https` IS
 * installed, and `https.get` / `https.request` are a real bypass route that a
 * fetch-only guard would miss entirely.
 *
 * This proves the interceptor covers node's low-level HTTP client, not just the
 * global `fetch`.
 *
 * Invoked only by lane6-egress-enforcement.test.ts, which asserts it FAILS with
 * the sentinel.
 */

import https from "node:https";

export async function attemptBypass(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      "https://store.example.com/wp-json/wc/v3/products/batch",
      { method: "POST" },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ update: [{ id: 1, stock_status: "outofstock" }] }));
  });
}
