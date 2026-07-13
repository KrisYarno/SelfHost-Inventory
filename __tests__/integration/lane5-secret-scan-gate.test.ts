// @jest-environment node
/**
 * Lane 5 S1 secret-comparison scan gate (spec §3 S1; codex #10/#15).
 *
 * THE GATE: no `app/api/**​/route.ts` may compare a CRON_SECRET or INTERNAL_SYNC_TOKEN
 * value with an equality operator inline — every such comparison must route through the
 * timing-safe helpers in `lib/security/secret-compare.ts` (bearerAuthorized /
 * headerTokenAuthorized / timingSafeStringEqual). A raw `authHeader !== \`Bearer ${...}\``
 * or `process.env.CRON_SECRET === x` leaks timing and is caught here BY FILE.
 *
 * Mechanics (source-text scan, same family as change-tracking-coverage.test.ts):
 *  1. Strip comments (block + line) so prose mentioning the secret cannot false-positive.
 *  2. Collapse all whitespace/newlines to single spaces (rev-2: multiline comparisons
 *     cannot evade the match).
 *  3. Split into statement segments on `;`; a segment is a VIOLATION iff it contains a
 *     secret name AND an equality operator `[!=]==?` (==, ===, !=, !==). Assignment `=`
 *     and arrow `=>` do not match.
 *  4. Self-check: the helpers must appear at ≥5 real call sites, so the gate cannot pass
 *     vacuously (e.g. if every route stopped touching the secrets).
 *
 * Known heuristic limit (documented, not engineered away): a comparison against a LOCAL
 * variable that was assigned from the secret (`const s = process.env.CRON_SECRET; if (x!==s)`)
 * does not carry the literal secret name in the comparison statement and would not be
 * flagged. House style keeps the secret literal at the comparison site; the helpers make
 * that the path of least resistance.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, "app", "api");

const SECRET_NAMES = /(CRON_SECRET|INTERNAL_SYNC_TOKEN)/;
const EQUALITY_OP = /[!=]==?/;
const HELPER_CALL = /\b(bearerAuthorized|headerTokenAuthorized|timingSafeStringEqual)\s*\(/g;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\/\/[^\n]*/g, " "); // line comments
}

function normalize(src: string): string {
  return stripComments(src).replace(/\s+/g, " ");
}

/** Statement segments that inline-compare a secret family value. Empty = clean. */
function findSecretComparisons(sourceText: string): string[] {
  return normalize(sourceText)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => SECRET_NAMES.test(s) && EQUALITY_OP.test(s));
}

function discoverRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...discoverRouteFiles(full));
    else if (entry.isFile() && entry.name === "route.ts") found.push(full);
  }
  return found.sort();
}

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

describe("Lane 5 secret-comparison scan gate (S1)", () => {
  const routeFiles = discoverRouteFiles(API_DIR);

  it("finds a sane route surface (guards against discovery rot)", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(80);
  });

  it("no route inline-compares CRON_SECRET / INTERNAL_SYNC_TOKEN (must use lib/security helpers)", () => {
    const violations: string[] = [];
    for (const abs of routeFiles) {
      const offending = findSecretComparisons(fs.readFileSync(abs, "utf8"));
      for (const seg of offending) {
        violations.push(`  ${toRepoPath(abs)}\n    -> ${seg}`);
      }
    }
    expect(
      violations.length === 0
        ? ""
        : `Routes compare a secret inline instead of via lib/security/secret-compare.ts —\n` +
            `replace the comparison with bearerAuthorized(...) / headerTokenAuthorized(...):\n` +
            violations.join("\n")
    ).toBe("");
  });

  it("the timing-safe helpers are actually adopted (>=5 call sites; gate cannot pass vacuously)", () => {
    let callSites = 0;
    for (const abs of routeFiles) {
      const src = fs.readFileSync(abs, "utf8");
      const matches = src.match(HELPER_CALL);
      if (matches) callSites += matches.length;
    }
    expect(callSites).toBeGreaterThanOrEqual(5);
  });

  // rev-2: prove the scanner catches a MULTILINE comparison (evasion attempt) and does
  // NOT flag the legitimate helper-call form.
  describe("scanner fixtures", () => {
    it("detects a multiline inline comparison", () => {
      const multiline = [
        "const authHeader = request.headers.get('authorization');",
        "if (",
        "  !process.env.CRON_SECRET ||",
        "  authHeader !==",
        "    `Bearer ${process.env.CRON_SECRET}`",
        ") {",
        "  return unauthorized();",
        "}",
      ].join("\n");
      expect(findSecretComparisons(multiline).length).toBeGreaterThan(0);
    });

    it("detects the reversed operand order (secret on the left)", () => {
      const rev = "if (process.env.INTERNAL_SYNC_TOKEN === provided) { ok(); }";
      expect(findSecretComparisons(rev).length).toBeGreaterThan(0);
    });

    it("does NOT flag the helper-call form", () => {
      const good =
        "if (!bearerAuthorized(authHeader, process.env.CRON_SECRET)) { return unauthorized(); }";
      expect(findSecretComparisons(good)).toEqual([]);
    });

    it("does NOT flag a comment that mentions the secret with an operator", () => {
      const commented =
        "// legacy: authHeader !== `Bearer ${process.env.CRON_SECRET}`\nreturn bearerAuthorized(h, process.env.CRON_SECRET);";
      expect(findSecretComparisons(commented)).toEqual([]);
    });
  });
});
