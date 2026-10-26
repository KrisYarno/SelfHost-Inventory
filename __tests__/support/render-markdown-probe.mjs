// @ts-check
/**
 * __tests__/support/render-markdown-probe.mjs — render the REAL assistant markdown
 * renderer (components/assistant/markdown.tsx) to static HTML (assistant A1 pack C2).
 *
 * WHY A SPAWNED SCRIPT. react-markdown (and its unified/remark/rehype graph) is
 * ESM-only and cannot load under the root jest transform — the same reason the launch
 * gate's title probe is a spawned script (launch-gate/spike-a-title.mjs). So the render
 * test (__tests__/unit/components/assistant-markdown-render.test.ts) spawns this file:
 * it bundles the component with esbuild (esm-bundle.mjs), imports the bundle, and
 * renders it with react-dom/server. No mock, no copy: what renders here is what the
 * chat renders.
 *
 * Plain .mjs, so no JSX: elements are made with `createElement`. React, react-dom and
 * the markdown stack stay EXTERNAL so the bundle and react-dom/server share one React.
 *
 * I/O: stdin = a JSON array of markdown strings; stdout = ONE JSON array of HTML
 * strings, same order. Any bundle/import/render failure exits non-zero with the error
 * on stderr (the caller treats that as a harness failure, never as a test result).
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bundleToCache } from "./esm-bundle.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(REPO_ROOT, "components", "assistant", "markdown.tsx");
const EXTERNAL = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react-markdown",
  "remark-gfm",
  "rehype-sanitize",
  "lucide-react",
  "sonner",
];

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const inputs = JSON.parse(await readStdin());
  if (!Array.isArray(inputs) || !inputs.every((s) => typeof s === "string")) {
    throw new Error("stdin must be a JSON array of markdown strings");
  }
  const outfile = await bundleToCache(ENTRY, { external: EXTERNAL });
  const mod = await import(pathToFileURL(outfile).href);
  if (typeof mod.AssistantMarkdown !== "function") {
    throw new Error(`the bundle of ${ENTRY} does not export AssistantMarkdown`);
  }
  const html = inputs.map((markdown) =>
    renderToStaticMarkup(createElement(mod.AssistantMarkdown, null, markdown)),
  );
  process.stdout.write(JSON.stringify(html));
} catch (err) {
  process.stderr.write(
    `render-markdown-probe: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
}
