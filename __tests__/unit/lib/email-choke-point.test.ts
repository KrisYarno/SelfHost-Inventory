/**
 * @jest-environment node
 *
 * N0 (C2d) — the GREP PINS that hold the email choke point in place.
 *
 *   1. No file outside lib/email.ts imports @sendgrid/* (scanning app/, lib/,
 *      components/, scripts/ and mcp/), so nothing can reach the provider except
 *      through `deliver`.
 *   2. Inside lib/email.ts there is exactly ONE `.send(` call (deliver's).
 *   3. healthz never imports @/lib/email (FV-9): its posture comes from
 *      lib/notifications/delivery-posture.ts.
 *
 * The behaviour behind them is pinned in email-deliver.test.ts.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCAN_DIRS = ["app", "lib", "components", "scripts", "mcp"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage"]);

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

// import ... from "@sendgrid/x" | import("@sendgrid/x") | require("@sendgrid/x") | export ... from
const SENDGRID_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']@sendgrid\//;

describe("N0 C2d — the email choke point (grep pins)", () => {
  it("scans a non-trivial tree (the sweep is not vacuous)", () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir), files);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(path.join(REPO_ROOT, "lib", "email.ts"));
    // The detector itself trips on the one legitimate importer.
    expect(SENDGRID_IMPORT.test(fs.readFileSync(path.join(REPO_ROOT, "lib", "email.ts"), "utf8"))).toBe(
      true
    );
  });

  it("no file outside lib/email.ts imports @sendgrid/*", () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir), files);
    const offenders = files
      .filter((file) => path.relative(REPO_ROOT, file) !== path.join("lib", "email.ts"))
      .filter((file) => SENDGRID_IMPORT.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("inside lib/email.ts there is exactly ONE `.send(` call", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "lib", "email.ts"), "utf8");
    const calls = source.match(/\.send\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // ...and it is the provider's, inside deliver.
    const deliverStart = source.indexOf("export async function deliver(");
    const deliverEnd = source.indexOf("\nconst HTML_ESCAPES");
    expect(deliverStart).toBeGreaterThan(-1);
    expect(deliverEnd).toBeGreaterThan(deliverStart);
    expect(source.slice(deliverStart, deliverEnd)).toMatch(/\bsgMail\.send\s*\(/);
  });

  it("healthz never imports @/lib/email (its posture comes from delivery-posture)", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "app", "api", "healthz", "route.ts"), "utf8");
    expect(source).not.toMatch(/["']@\/lib\/email["']/);
    expect(source).toMatch(/["']@\/lib\/notifications\/delivery-posture["']/);
  });
});
