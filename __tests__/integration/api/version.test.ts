/**
 * @jest-environment node
 */

/**
 * /api/version — the build-identity probe (2026-07-16 stale-image incident).
 *
 * Pins three things:
 *   1. absent build-info.json (next dev, jest) degrades to "unknown"/"unknown"
 *      with a 200 — the probe never throws;
 *   2. a baked build-info.json is relayed verbatim (the rebuild-verification
 *      contract: /api/version === `git rev-parse HEAD`);
 *   3. malformed JSON degrades to "unknown" instead of failing.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { GET } from "@/app/api/version/route";

const origCwd = process.cwd();

function inTempCwd(setup?: (dir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "version-probe-"));
  setup?.(dir);
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  process.chdir(origCwd);
});

describe("GET /api/version", () => {
  it("degrades to unknown/unknown when build-info.json is absent", async () => {
    const dir = inTempCwd();
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ sha: "unknown", builtAt: "unknown" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("relays a baked build-info.json verbatim", async () => {
    const dir = inTempCwd((d) => {
      writeFileSync(
        path.join(d, "build-info.json"),
        JSON.stringify({ sha: "abc123def", builtAt: "2026-07-16T20:00:00Z" }),
      );
    });
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sha: "abc123def",
      builtAt: "2026-07-16T20:00:00Z",
    });
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("degrades malformed JSON to unknown instead of failing", async () => {
    const dir = inTempCwd((d) => {
      writeFileSync(path.join(d, "build-info.json"), "not json {");
    });
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ sha: "unknown", builtAt: "unknown" });
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });
});
