/**
 * build-smoke.test.ts — proves the SHIPPED artifact: tsup bundles src/server.ts
 * (mock-prisma variant) into an ESM bundle, `node dist-test/server.js` starts the
 * real MCP server (real `ai` + MCP SDK under Node ESM — not the jest CJS stub), and
 * a tool round-trip succeeds over HTTP. Also proves the disabled-mode process exits 0.
 *
 * This is the end-to-end bundle proof the Dockerfile.mcp relies on.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import fs from "node:fs";

const mcpDir = path.resolve(__dirname, "..");
const outDir = "dist-test";
const bundlePath = path.join(mcpDir, outDir, "server.js");
const VALID_TOKEN = "invmcp_" + "A".repeat(43);

const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function spawnServer(env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [path.join(outDir, "server.js")], {
    cwd: mcpDir,
    env: { ...process.env, NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitForHealth(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("sidecar did not become healthy in time");
}

beforeAll(() => {
  // Build the mock-prisma server bundle into an isolated outDir.
  execFileSync("npx", ["--no-install", "tsup"], {
    cwd: mcpDir,
    env: { ...process.env, MCP_BUILD_MOCK: "1", MCP_OUT_DIR: outDir },
    stdio: "ignore",
  });
  expect(fs.existsSync(bundlePath)).toBe(true);
}, 120_000);

afterAll(() => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
  fs.rmSync(path.join(mcpDir, outDir), { recursive: true, force: true });
});

describe("built artifact", () => {
  it(
    "starts from the bundle and serves a find_product tool round-trip over HTTP",
    async () => {
      const port = await freePort();
      spawnServer({ ENABLE_MCP: "1", MCP_PORT: String(port) });
      await waitForHealth(port);

      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "find_product", arguments: { query: "abc" } },
        }),
      });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpc = (await res.json()) as any;
      const toolResult = JSON.parse(rpc.result.content[0].text);
      expect(toolResult.status).toBe("ok");
      // find_product now carries a caller-honest coverage block (W0-2 / spec §7).
      expect(toolResult.data).toEqual({
        products: [],
        returned: 0,
        totalRows: 0,
        nextOffset: null,
        coverage: { matched: 0, scope: "approved products; name/baseName/variant match" },
      });
    },
    30_000,
  );

  it(
    "exits 0 cleanly in disabled mode (ENABLE_MCP != '1')",
    async () => {
      const child = spawnServer({ ENABLE_MCP: "0" });
      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", (c) => resolve(c));
      });
      expect(code).toBe(0);
    },
    15_000,
  );
});
