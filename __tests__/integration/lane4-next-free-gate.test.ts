/**
 * @jest-environment node
 *
 * Lane 4 trunk gate (plan P-M4 / spec D8): the module graph of `lib/assistant/**`
 * plus `lib/analytics/serialize.ts` must be NEXT-FREE — it may never reach `next/*`
 * or `@/lib/api-utils`. That boundary is what lets the MCP sidecar bundle the shared
 * tool layer without dragging Next server internals into its build.
 *
 * This is a STATIC transitive import walk (no modules are executed): it parses import
 * specifiers, follows every LOCAL (`@/` or relative) edge to its .ts target, and
 * fails if any reached file imports from `next/*` or resolves an import to
 * `lib/api-utils.ts`. Bare node_modules (ai, @modelcontextprotocol/sdk, zod,
 * @prisma/client, node builtins) are allowed — except `next`.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = process.cwd();

const ENTRY_DIRS = ["lib/assistant"];
const EXTRA_ENTRIES = ["lib/analytics/serialize.ts"];
const API_UTILS = "lib/api-utils.ts";

function listTsFiles(relDir: string): string[] {
  const abs = path.join(REPO_ROOT, relDir);
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Extract module specifiers from `from '…'`, side-effect `import '…'`, and
 *  dynamic `import('…')`. Good enough for source-graph policing. */
function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

/** Resolve a LOCAL import to a repo-relative .ts(x) path, or null for bare modules. */
function resolveLocal(spec: string, fromRel: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = path.join(REPO_ROOT, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.resolve(path.dirname(path.join(REPO_ROOT, fromRel)), spec);
  } else {
    return null; // bare module (node_modules / builtin)
  }
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(cand)) return path.relative(REPO_ROOT, cand).split(path.sep).join("/");
  }
  return null;
}

function isNext(spec: string): boolean {
  return spec === "next" || spec.startsWith("next/");
}

interface Walk {
  visited: Set<string>;
  violations: string[];
}

function walk(entries: string[]): Walk {
  const visited = new Set<string>();
  const violations: string[] = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const rel = queue.pop() as string;
    if (visited.has(rel)) continue;
    visited.add(rel);

    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    for (const spec of extractSpecifiers(source)) {
      if (isNext(spec)) {
        violations.push(`${rel} -> "${spec}" (next/*)`);
        continue;
      }
      const resolved = resolveLocal(spec, rel);
      if (resolved === null) continue; // allowed bare module
      if (resolved === API_UTILS) {
        violations.push(`${rel} -> "${spec}" (lib/api-utils)`);
        continue;
      }
      queue.push(resolved);
    }
  }

  return { visited, violations };
}

describe("lane4 next-free gate: lib/assistant/** + serialize.ts never reach next/* or lib/api-utils", () => {
  const entries = [...ENTRY_DIRS.flatMap(listTsFiles), ...EXTRA_ENTRIES];
  const result = walk(entries);

  it("walks a plausible, connected module graph (self-check)", () => {
    // Entry files present.
    expect(entries).toContain("lib/assistant/tools.ts");
    expect(entries).toContain("lib/assistant/providers.ts");
    expect(entries).toContain("lib/analytics/serialize.ts");
    // Transitive reach: the tool graph pulls these in.
    expect(result.visited.has("lib/reports/low-stock.ts")).toBe(true);
    expect(result.visited.has("lib/products.ts")).toBe(true);
    expect(result.visited.has("lib/analytics/queries.ts")).toBe(true);
    expect(result.visited.has("lib/validation/ai.ts")).toBe(true);
    expect(result.visited.size).toBeGreaterThan(10);
  });

  it("the extractor + resolver actually detect a next/api-utils edge (negative control)", () => {
    // lib/api-utils.ts genuinely imports next/server; prove the machinery catches it
    // so the empty-violations assertion below cannot pass vacuously.
    const control = walk([API_UTILS]);
    expect(control.violations.some((v) => v.includes("next/"))).toBe(true);
  });

  it("has ZERO next/* or lib/api-utils reaches in the assistant graph", () => {
    expect(result.violations).toEqual([]);
  });
});
