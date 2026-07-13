import { defineConfig, type Options } from "tsup";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The sidecar bundles the shared lib/assistant tool layer via the `@` alias and
// externalises every bare package import (`packages: "external"`), so `ai`,
// `@modelcontextprotocol/sdk`, `@prisma/client`, `zod` and transitive deps resolve
// from node_modules at runtime (the Dockerfile.mcp ships node_modules + the
// generated Prisma client). ESM output — matches the MCP SDK's ESM-only shape.
//
// Builds:
//   default `tsup`            -> dist/server.js  (REAL @/lib/prisma)  [production]
//                            +  dist/smoke.js   (MOCK prisma)        [npm run smoke]
//   MCP_BUILD_MOCK=1 tsup     -> <out>/server.js (MOCK prisma)        [artifact smoke test]
//   MCP_OUT_DIR=<dir>         -> override the output directory (test isolation)

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const prismaMock = path.resolve(here, "src/prisma-mock.ts");

const base: Omit<Options, "name" | "entry" | "outDir" | "clean" | "esbuildOptions"> = {
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  sourcemap: false,
};

export default defineConfig(() => {
  const buildMock = process.env.MCP_BUILD_MOCK === "1";
  const outDir = process.env.MCP_OUT_DIR ?? "dist";

  const serverAlias: Record<string, string> = buildMock
    ? { "@/lib/prisma": prismaMock, "@": repoRoot }
    : { "@": repoRoot };

  // A mock/custom build is a single, isolated artifact (the built-artifact smoke
  // test builds into its own outDir) — safe to `clean` since nothing else writes there.
  if (buildMock || process.env.MCP_OUT_DIR) {
    return {
      ...base,
      name: "server",
      entry: { server: "src/server.ts" },
      outDir,
      clean: true,
      esbuildOptions(options) {
        options.packages = "external";
        options.alias = serverAlias;
      },
    } satisfies Options;
  }

  // Default build emits BOTH the real server and the mock smoke bundle into dist/.
  // Neither cleans — they run in parallel and each simply overwrites its own file,
  // so there is no clean-vs-write race between the two configs.
  const server: Options = {
    ...base,
    name: "server",
    entry: { server: "src/server.ts" },
    outDir,
    clean: false,
    esbuildOptions(options) {
      options.packages = "external";
      options.alias = { "@": repoRoot };
    },
  };
  const smoke: Options = {
    ...base,
    name: "smoke",
    entry: { smoke: "src/smoke.ts" },
    outDir,
    clean: false,
    esbuildOptions(options) {
      options.packages = "external";
      options.alias = { "@/lib/prisma": prismaMock, "@": repoRoot };
    },
  };

  return [server, smoke];
});
