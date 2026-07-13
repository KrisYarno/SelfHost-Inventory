/**
 * mcp/src/smoke.ts — proves the alias-bundling shape NOW (codex #8/#9).
 *
 * Imports ONE real shared tool from the app's lib layer via the `@` alias, and
 * invokes it against the tsup-aliased prisma mock. `npx tsup` bundles this entry;
 * running the built `dist/smoke.js` executes the tool with no database. This is the
 * skeleton contract the T5 sidecar builds on (its Dockerfile.mcp uses the same tsup
 * bundle).
 */

import { assistantTools } from "@/lib/assistant/tools";

async function main(): Promise<void> {
  const tool = assistantTools.find_product;
  const result = await tool.run(
    { query: "smoke" },
    { userId: 1, isAdmin: false, companyIds: [], surface: "mcp" },
  );
  // eslint-disable-next-line no-console
  console.log("[mcp-smoke] find_product ->", JSON.stringify(result));
  if (result.status !== "ok") {
    throw new Error(`[mcp-smoke] unexpected tool status: ${result.status}`);
  }
  // eslint-disable-next-line no-console
  console.log("[mcp-smoke] OK: alias-bundled shared tool executed against a mocked prisma");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mcp-smoke] FAILED", err);
  process.exit(1);
});
