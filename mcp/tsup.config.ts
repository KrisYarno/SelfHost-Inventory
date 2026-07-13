import { defineConfig } from "tsup";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// Bundle the shared lib/assistant tool layer via the `@` alias (proving the
// alias-bundling shape T5's Dockerfile.mcp relies on). `@/lib/prisma` is aliased to
// a local mock so the smoke build runs WITHOUT a database; real runtime deps stay
// external and resolve from node_modules.
export default defineConfig({
  entry: ["src/smoke.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  bundle: true,
  external: [
    "@prisma/client",
    "zod",
    "ai",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai",
    "@ai-sdk/google",
    "ai-sdk-ollama",
    "@modelcontextprotocol/sdk",
  ],
  esbuildOptions(options) {
    options.alias = {
      // More specific first: bind the shared tool graph's prisma import to the mock.
      "@/lib/prisma": path.resolve(here, "src/prisma-mock.ts"),
      "@": repoRoot,
    };
  },
});
