/**
 * @jest-environment node
 *
 * N0 D2 (FV-3) — real email is fail-closed BY CONSTRUCTION, not by procedure.
 *
 *   - docker-compose.yml (the base every stack builds on: dev, the `rebuild` QA
 *     project, StagingProduction's local overlay): the app's EMAIL_DELIVERY is the
 *     LITERAL "off" — no ${...} passthrough — and EMAIL_ALLOWLIST is not forwarded.
 *   - compose.stack.yml (the PROD overlay, its only user): the passthrough
 *     EMAIL_DELIVERY: ${EMAIL_DELIVERY:-off} and EMAIL_ALLOWLIST: ${EMAIL_ALLOWLIST:-}.
 *   - compose.dev.lan.yml (the dev overlay): the deliberate escape hatch reads
 *     DEV_EMAIL_DELIVERY / DEV_EMAIL_ALLOWLIST, never the prod-shaped names.
 *
 * Read as TEXT (no YAML library): each assertion is on exact lines inside the
 * `app:` service block — from the line `  app:` to the next line that opens
 * another two-space key (or a top-level key) — and, within it, the
 * `    environment:` map. A commented-out line or a line under another service
 * cannot satisfy them. compose.dev.lan.yml is machine-local (gitignored), so its
 * pin runs only where the file exists.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function lines(file: string): string[] {
  return fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n").split("\n");
}

/** The lines strictly after `opener` up to (not including) the next line matching `end`. */
function block(source: string[], opener: string, end: RegExp): string[] {
  const starts = source.map((line, i) => (line === opener ? i : -1)).filter((i) => i >= 0);
  expect(starts).toHaveLength(1); // exactly one such block
  const out: string[] = [];
  for (let i = starts[0] + 1; i < source.length; i++) {
    if (end.test(source[i])) break;
    out.push(source[i]);
  }
  return out;
}

/** The app service's `environment:` map, as raw lines. */
function appEnvironment(file: string): string[] {
  const app = block(lines(file), "  app:", /^ {2}\S|^\S/);
  return block(app, "    environment:", /^ {4}\S|^ {0,3}\S/);
}

/** Uncommented `KEY:` lines (any indentation) — what compose would actually read. */
function keyLines(source: string[], key: string): string[] {
  return source.filter((line) => new RegExp(`^\\s*${key}\\s*:`).test(line));
}

describe("D2: compose email delivery posture", () => {
  it('docker-compose.yml pins the app to the LITERAL "off" and does not forward EMAIL_ALLOWLIST', () => {
    const env = appEnvironment("docker-compose.yml");
    expect(keyLines(env, "EMAIL_DELIVERY")).toEqual(['      EMAIL_DELIVERY: "off"']);
    expect(keyLines(env, "EMAIL_ALLOWLIST")).toEqual([]);
    expect(keyLines(env, "DEV_EMAIL_DELIVERY")).toEqual([]);
    // The provider key itself is still forwarded (the switch, not the key, gates mail).
    expect(keyLines(env, "SENDGRID_API_KEY")).toEqual(["      SENDGRID_API_KEY: ${SENDGRID_API_KEY:-}"]);
  });

  it("nowhere else in the base file is a delivery variable set", () => {
    const all = lines("docker-compose.yml");
    expect(keyLines(all, "EMAIL_DELIVERY")).toEqual(['      EMAIL_DELIVERY: "off"']);
    expect(keyLines(all, "EMAIL_ALLOWLIST")).toEqual([]);
  });

  it("compose.stack.yml (the PROD overlay) passes EMAIL_DELIVERY / EMAIL_ALLOWLIST through, defaulting off", () => {
    const env = appEnvironment("compose.stack.yml");
    expect(keyLines(env, "EMAIL_DELIVERY")).toEqual(["      EMAIL_DELIVERY: ${EMAIL_DELIVERY:-off}"]);
    expect(keyLines(env, "EMAIL_ALLOWLIST")).toEqual(["      EMAIL_ALLOWLIST: ${EMAIL_ALLOWLIST:-}"]);
  });

  const devOverlay = path.join(ROOT, "compose.dev.lan.yml");
  (fs.existsSync(devOverlay) ? it : it.skip)(
    "compose.dev.lan.yml reads the DEV_ escape hatch, never the prod-shaped names",
    () => {
      const env = appEnvironment("compose.dev.lan.yml");
      expect(keyLines(env, "EMAIL_DELIVERY")).toEqual(["      EMAIL_DELIVERY: ${DEV_EMAIL_DELIVERY:-off}"]);
      expect(keyLines(env, "EMAIL_ALLOWLIST")).toEqual(["      EMAIL_ALLOWLIST: ${DEV_EMAIL_ALLOWLIST:-}"]);
    }
  );
});

// N0 FR1 E9 / E12: the launch gate's app can never send, and the env template says
// where `on` may live.
describe("FR1: no stack built from this repo can send by accident", () => {
  it("launch-gate/spawn.ts pins EMAIL_DELIVERY off AND an empty provider key for the app under test", () => {
    const spawn = lines("launch-gate/spawn.ts");
    expect(keyLines(spawn, "EMAIL_DELIVERY")).toEqual(['    EMAIL_DELIVERY: "off",']);
    expect(keyLines(spawn, "SENDGRID_API_KEY")).toEqual(['    SENDGRID_API_KEY: "",']);
  });

  it(".env.example says never to put EMAIL_DELIVERY=on in a repo-root .env", () => {
    expect(lines(".env.example")).toContain(
      "# NEVER set EMAIL_DELIVERY=on in a repo-root .env — only the production server's env read by compose.stack.yml."
    );
  });
});
