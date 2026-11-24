/**
 * @jest-environment node
 *
 * N0 (C2d, FR1 E7) — the GREP PINS that hold the email choke point in place.
 *
 *   1. SCOPE = git's own file list (`git ls-files --cached --others
 *      --exclude-standard`, from the repo root): every tracked file plus every
 *      untracked file that is not ignored — so never `.claude/`, `dumps/`, a
 *      secret `.env`, or build output. If git cannot run, the test FAILS loudly.
 *   2. Over that scope, `@sendgrid/` and `api.sendgrid.com` appear ONLY in
 *      lib/email.ts, package.json, package-lock.json, jest.setup.js and files
 *      under __tests__/ — nothing else can name the provider package or its API.
 *   3. Inside lib/email.ts: exactly ONE `.send(` call, and every `sgMail`
 *      reference is the import, the module-top setApiKey, or deliver's send.
 *   4. healthz never imports @/lib/email (FV-9): its posture comes from
 *      lib/notifications/delivery-posture.ts.
 *
 * The behaviour behind them is pinned in email-deliver.test.ts.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

// Built from parts so this file's own text is not what the scan finds.
const PACKAGE_MARKER = ["@send", "grid/"].join("");
const API_HOST_MARKER = ["api", "sendgrid", "com"].join(".");

/** The ONLY files allowed to name the provider package or its API host. */
function allowedToNameProvider(file: string): boolean {
  return (
    file === "lib/email.ts" ||
    file === "package.json" ||
    file === "package-lock.json" ||
    file === "jest.setup.js" ||
    file.startsWith("__tests__/")
  );
}

/** git's file list, relative to the repo root. Throws (fails the test) if git cannot run. */
function gitScope(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return Array.from(new Set(out.split("\0").filter((file) => file !== "")));
}

function filesNaming(scope: string[], marker: string): string[] {
  return scope.filter((file) => {
    const full = path.join(REPO_ROOT, file);
    // A tracked file deleted in the working tree has nothing left to scan.
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
    return fs.readFileSync(full, "utf8").includes(marker);
  });
}

describe("N0 C2d / FR1 E7 — the email choke point (grep pins over git's file list)", () => {
  const scope = gitScope();

  it("the scope is git's list: non-trivial, and never ignored data or secrets", () => {
    expect(scope.length).toBeGreaterThan(500);
    for (const required of ["lib/email.ts", "package.json", "middleware.ts", "hooks/use-analytics.ts"]) {
      expect(scope).toContain(required);
    }
    expect(scope.some((file) => file.startsWith("launch-gate/"))).toBe(true);
    expect(scope.filter((file) => /^(\.claude|dumps|\.next|node_modules|docs)\//.test(file))).toEqual([]);
    // .env.example is a tracked template; no other .env* file is ever in scope.
    expect(scope.filter((file) => /(^|\/)\.env/.test(file) && file !== ".env.example")).toEqual([]);
  });

  it("the detectors are not vacuous: lib/email.ts names the package; the allowed set holds", () => {
    expect(filesNaming(scope, PACKAGE_MARKER)).toContain("lib/email.ts");
    expect(allowedToNameProvider("__tests__/unit/lib/email-deliver.test.ts")).toBe(true);
    expect(allowedToNameProvider("lib/stock-checker.ts")).toBe(false);
    expect(allowedToNameProvider("hooks/use-analytics.ts")).toBe(false);
  });

  it("`@sendgrid/` appears ONLY in lib/email.ts, the package manifests, jest.setup.js and __tests__/", () => {
    expect(filesNaming(scope, PACKAGE_MARKER).filter((file) => !allowedToNameProvider(file))).toEqual([]);
  });

  it("`api.sendgrid.com` appears ONLY in that same set (no raw fetch to the provider's API)", () => {
    expect(filesNaming(scope, API_HOST_MARKER).filter((file) => !allowedToNameProvider(file))).toEqual([]);
  });

  // N0 FR2 F4: inside lib/email.ts the package is named EXACTLY ONCE — the one
  // import — so a second import (of @sendgrid/client, say) cannot hide there.
  it("lib/email.ts names the provider package exactly once (its one import)", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "lib", "email.ts"), "utf8");
    expect(source.split(PACKAGE_MARKER)).toHaveLength(2);
    expect(source).toMatch(/^import sgMail, \{ type MailDataRequired \} from '@sendgrid\/mail';\r?$/m);
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

  // N0 FR1 E7 (the part that holds against the tree; see the FR1 report): every
  // reference to the provider client in lib/email.ts is the import, the module-top
  // setApiKey, or THE one send inside deliver — so a sendMultiple, a bracket access
  // (sgMail["send"]) or an alias would fail here.
  it("every sgMail reference in lib/email.ts is the import, setApiKey at module top, or deliver's send", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "lib", "email.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(source.match(/\bsgMail\b/g) ?? []).toHaveLength(3);

    const lines = source.split("\n");
    const refs = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /\bsgMail\b/.test(line));
    const deliverStart = lines.findIndex((l) => l.startsWith("export async function deliver("));
    const deliverEnd = lines.findIndex((l, i) => i > deliverStart && l === "}");
    const firstFunction = lines.findIndex((l) => /^(export )?(async )?function |^export class /.test(l));

    expect(refs.map(({ line }) => line.trim())).toEqual([
      "import sgMail, { type MailDataRequired } from '@sendgrid/mail';",
      "sgMail.setApiKey(process.env.SENDGRID_API_KEY);",
      "await sgMail.send(outbound as MailDataRequired);",
    ]);
    // setApiKey sits at module top (before any function); send sits inside deliver.
    expect(refs[1].index).toBeLessThan(firstFunction);
    expect(refs[2].index).toBeGreaterThan(deliverStart);
    expect(refs[2].index).toBeLessThan(deliverEnd);
  });

  it("healthz never imports @/lib/email (its posture comes from delivery-posture)", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "app", "api", "healthz", "route.ts"), "utf8");
    expect(source).not.toMatch(/["']@\/lib\/email["']/);
    expect(source).toMatch(/["']@\/lib\/notifications\/delivery-posture["']/);
  });
});
