// @jest-environment node
/**
 * Lane 5 I6 deploy-manifest golden test (plan Task 5; codex #17).
 *
 * Stale = files present under <targetDir> that are NOT tracked in git AND NOT matched by the
 * protect list. This test drives a real fixture tree in os.tmpdir(): a tracked-mirror set,
 * 3 genuinely-stale files, and 2 protected files -> exactly the 3 stale come back.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require("../../../scripts/deploy-manifest.js");
const { computeStale, isProtected, walkFiles, getTrackedFiles, PROTECT_LIST } = manifest;

function mk(dir: string, rel: string, body = "x"): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

describe("computeStale (golden fixture)", () => {
  let target: string;

  beforeAll(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "lane5-manifest-"));

    // tracked-mirror (present in target AND tracked in git => NOT stale)
    mk(target, "src/app.js");
    mk(target, "README.md");
    mk(target, "package.json");

    // 3 stale (present, NOT tracked, NOT protected => the answer)
    mk(target, "src/old-removed.js");
    mk(target, "orphan.txt");
    mk(target, "nested/dir/stale.tsx");

    // 2 protected (present, NOT tracked, but protected => NOT stale)
    mk(target, ".env.production");
    mk(target, "dumps/backup.sql");
  });

  afterAll(() => {
    fs.rmSync(target, { recursive: true, force: true });
  });

  const tracked = ["src/app.js", "README.md", "package.json"];

  test("returns exactly the 3 stale files", () => {
    const stale = computeStale(target, tracked).sort();
    expect(stale).toEqual(
      ["nested/dir/stale.tsx", "orphan.txt", "src/old-removed.js"].sort()
    );
  });

  test("walkFiles finds every file relative to target (POSIX)", () => {
    const all = walkFiles(target).sort();
    expect(all).toContain("src/app.js");
    expect(all).toContain("dumps/backup.sql");
    expect(all).toContain(".env.production");
    expect(all).toContain("nested/dir/stale.tsx");
  });
});

describe("isProtected (minimatch-free glob)", () => {
  test(".env* matches dotenv variants at any depth", () => {
    expect(isProtected(".env", PROTECT_LIST)).toBe(true);
    expect(isProtected(".env.production", PROTECT_LIST)).toBe(true);
    expect(isProtected("config/.env.local", PROTECT_LIST)).toBe(true);
  });

  test("compose.*.yml matches overlays but not an unrelated yml", () => {
    expect(isProtected("compose.dev.lan.yml", PROTECT_LIST)).toBe(true);
    expect(isProtected("compose.stack.yml", PROTECT_LIST)).toBe(true);
    expect(isProtected("docker-compose.yml", PROTECT_LIST)).toBe(true);
    expect(isProtected("vercel.json", PROTECT_LIST)).toBe(false);
  });

  test("dir/** patterns match nested contents", () => {
    expect(isProtected("node_modules/foo/bar.js", PROTECT_LIST)).toBe(true);
    expect(isProtected(".next/server/x.js", PROTECT_LIST)).toBe(true);
    expect(isProtected("public/uploads/img.png", PROTECT_LIST)).toBe(true);
    expect(isProtected("dumps/2026.sql.gz", PROTECT_LIST)).toBe(true);
    expect(isProtected("backup/old/db", PROTECT_LIST)).toBe(true);
  });

  test("extension patterns match at any depth", () => {
    expect(isProtected("logs/app.log", PROTECT_LIST)).toBe(true);
    expect(isProtected("seed.sql", PROTECT_LIST)).toBe(true);
    expect(isProtected("archive.sql.gz", PROTECT_LIST)).toBe(true);
    expect(isProtected("staging.sh", PROTECT_LIST)).toBe(true);
  });

  test("ordinary source files are not protected", () => {
    expect(isProtected("src/app.js", PROTECT_LIST)).toBe(false);
    expect(isProtected("orphan.txt", PROTECT_LIST)).toBe(false);
  });
});

describe("getTrackedFiles (spawns git ls-files once)", () => {
  test("returns this repo's tracked files including package.json", () => {
    const tracked = getTrackedFiles(process.cwd());
    expect(Array.isArray(tracked)).toBe(true);
    expect(tracked).toContain("package.json");
    expect(tracked.length).toBeGreaterThan(50);
  });
});

describe("CLI end-to-end", () => {
  const script = path.join(process.cwd(), "scripts", "deploy-manifest.js");
  let target: string;

  beforeAll(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "lane5-manifest-cli-"));
    mk(target, "package.json"); // tracked in the real repo => excluded
    mk(target, ".env.local"); // protected => excluded
    mk(target, "zzz-stale-artifact.txt"); // not tracked, not protected => stale
    mk(target, "another-stale.bin");
  });

  afterAll(() => {
    fs.rmSync(target, { recursive: true, force: true });
  });

  test("plain output lists stale files on stdout + summary on stderr, exit 0", () => {
    const res = spawnSync("node", [script, target], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("zzz-stale-artifact.txt");
    expect(res.stdout).toContain("another-stale.bin");
    expect(res.stdout).not.toContain("package.json");
    expect(res.stdout).not.toContain(".env.local");
    expect(res.stderr).toMatch(/STALE: 2 files/);
  });

  test("--json emits a JSON array of the stale files on stdout, exit 0", () => {
    const res = spawnSync("node", [script, target, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.sort()).toEqual(["another-stale.bin", "zzz-stale-artifact.txt"].sort());
  });
});
