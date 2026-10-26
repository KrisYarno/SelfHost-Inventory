// @ts-check
/**
 * __tests__/support/esm-bundle.mjs — bundle ONE repo source file (TS/TSX, the `@/`
 * alias) into a runnable ESM module for a spawned probe (assistant A1 pack C2).
 *
 * WHY. react-markdown and `ai` are ESM-only, and the root jest transform cannot load
 * them (lane4-assistant-ui.test.tsx mocks them for that reason). A test that needs the
 * REAL module graph spawns a plain node ESM process (precedent:
 * launch-gate/spike-a-title.mjs); this helper turns the repo's TypeScript entry into
 * something that process can `import()`.
 *
 * WHERE THE BUNDLE GOES. `<repo>/node_modules/.cache/assistant-probes/<sha1(entry)>.mjs`
 * — UNDER the repo, so Node's ESM resolution of the bundle's EXTERNAL imports walks up
 * to the repo's `node_modules` (a file in os.tmpdir() cannot resolve them; ESM ignores
 * NODE_PATH). Externals stay external so the probe and the bundle share ONE copy of
 * e.g. React.
 *
 * NO CACHE KEY. It rebuilds on every call: a key on the entry's mtime would miss a
 * change in one of its imports (lib/utils.ts, say), and esbuild takes milliseconds.
 *
 * JSX. The explicit `jsx: "automatic"` overrides tsconfig.json's `"jsx": "preserve"`
 * (the bundle imports `react/jsx-runtime`).
 *
 * General on purpose: no knowledge of any particular entry (the markdown render probe
 * and the A1 wire probe both use it).
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = path.join(REPO_ROOT, "node_modules", ".cache", "assistant-probes");

// Every compose up re-roots node_modules (the migrate service), which leaves the cache
// directory unwritable for the dev user until it is chowned back.
const EACCES_RECOVERY =
  `cannot write the probe bundle cache ${CACHE_DIR} (EACCES). node_modules was ` +
  `re-rooted (every compose up does this); recover with: ` +
  `docker run --rm -v "$PWD/node_modules:/nm" alpine chown -R 1000:1000 /nm`;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isEacces(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EACCES";
}

/**
 * Bundle `entryAbsPath` to an ESM file under node_modules/.cache/assistant-probes/.
 *
 * @param {string} entryAbsPath absolute path of the entry source file
 * @param {{ external: string[] }} options bare specifiers left as imports
 * @returns {Promise<string>} the absolute path of the written bundle
 */
export async function bundleToCache(entryAbsPath, { external }) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    // mkdir succeeds on an EXISTING root-owned directory; probe writability too, so the
    // re-rooted case names the recovery instead of surfacing as an esbuild write error.
    await access(CACHE_DIR, constants.W_OK);
  } catch (err) {
    if (isEacces(err)) throw new Error(EACCES_RECOVERY);
    throw err;
  }

  const outfile = path.join(
    CACHE_DIR,
    `${createHash("sha1").update(entryAbsPath).digest("hex")}.mjs`,
  );

  await build({
    entryPoints: [entryAbsPath],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".ts": "ts", ".tsx": "tsx" },
    alias: { "@": REPO_ROOT },
    external,
    outfile,
  });

  return outfile;
}
