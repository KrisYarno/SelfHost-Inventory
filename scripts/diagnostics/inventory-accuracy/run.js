#!/usr/bin/env node
//
// Phase 0a — the inventory-accuracy diagnostic runner.
//
// READ-ONLY. Every module in this suite issues SELECTs and nothing else: no
// $executeRaw, no model writes, no migrations, no service lifecycle. It is meant
// to be run BY THE ORCHESTRATOR against a StagingProduction restore of a FRESH
// prod dump, and its output (JSON + text per check) is what the committed
// diagnosis report is written from.
//
// Usage:
//   DATABASE_URL='mysql://user:pass@host:3306/db' \
//     node scripts/diagnostics/inventory-accuracy/run.js --out=<dir> [options]
//
// Options:
//   --out=<dir>                  REQUIRED. Artifacts are written here.
//   --checks=d1,d2,d3,d4         Which checks to run (default: all).
//   --window-days=90             D2 trailing window.
//   --snapshot-window-days=90    D3 trailing window.
//   --snapshot-max-rows=500000   D3 refuses to truncate; it aborts past this.
//   --top=50                     Top-N rows in ranked tables.
//   --order-rows=200             Max per-order detail rows in D1's table.
//   --census-since=2026-07-14    D4 logType census lower bound.
//   --class-b-floor=evidence|spec  Which class (b) observability floor BINDS.
//                                Both readings are always emitted; see D1's
//                                notes and the SEAMS report. EXACTLY one of the
//                                two tokens — anything else is a validation
//                                error, never coerced to a reading.
//
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { createClient, describeConnection } = require("./lib/db");
const { writeArtifact, jsonReplacer } = require("./lib/artifact");

const MODULES = [
  require("./d1-reconciliation"),
  require("./d2-inbound"),
  require("./d3-snapshot-walk"),
  require("./d4-checks"),
];

/** The only two accepted --class-b-floor readings. Exact tokens, never coerced. */
const CLASS_B_FLOOR_MODES = ["evidence", "spec"];

const DEFAULTS = {
  checks: ["d1", "d2", "d3", "d4"],
  windowDays: 90,
  snapshotWindowDays: 90,
  snapshotMaxRows: 500000,
  top: 50,
  orderRows: 200,
  censusSince: "2026-07-14",
  classBFloorMode: "evidence",
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, out: null };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) {
      if (!opts.out) opts.out = arg;
      continue;
    }
    const [, key, rawValue] = m;
    const value = rawValue ?? "";
    switch (key) {
      case "out":
        opts.out = value;
        break;
      case "checks":
        opts.checks = value
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        break;
      case "window-days":
        opts.windowDays = Number(value);
        break;
      case "snapshot-window-days":
        opts.snapshotWindowDays = Number(value);
        break;
      case "snapshot-max-rows":
        opts.snapshotMaxRows = Number(value);
        break;
      case "top":
        opts.top = Number(value);
        break;
      case "order-rows":
        opts.orderRows = Number(value);
        break;
      case "census-since":
        opts.censusSince = value;
        break;
      case "class-b-floor":
        // Kept VERBATIM: validate() rejects anything that is not one of the two
        // readings. Coercing here would let a typo silently bind a different
        // floor and the artifact would say nothing about it.
        opts.classBFloorMode = value;
        break;
      case "help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }
  return opts;
}

function validate(opts) {
  const errors = [];
  if (!opts.out) errors.push("--out=<dir> is required (where the artifacts are written)");
  for (const [key, label] of [
    ["windowDays", "--window-days"],
    ["snapshotWindowDays", "--snapshot-window-days"],
    ["snapshotMaxRows", "--snapshot-max-rows"],
    ["top", "--top"],
    ["orderRows", "--order-rows"],
  ]) {
    if (!Number.isFinite(opts[key]) || opts[key] <= 0) errors.push(`${label} must be a positive number`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.censusSince)) {
    errors.push("--census-since must be YYYY-MM-DD");
  }
  if (!CLASS_B_FLOOR_MODES.includes(opts.classBFloorMode)) {
    errors.push(
      `--class-b-floor must be exactly one of ${CLASS_B_FLOOR_MODES.join("|")} ` +
        `(got '${opts.classBFloorMode}') — an unrecognised value is NEVER coerced to a reading`
    );
  }
  const known = new Set(MODULES.map((m) => m.check.slice(0, 2)));
  for (const c of opts.checks) {
    if (!known.has(c)) errors.push(`--checks: unknown check '${c}' (known: ${[...known].join(",")})`);
  }
  return errors;
}

function repoHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(__dirname, "..", "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    // The header comment IS the usage text — keep them from drifting apart by
    // printing the real thing (the repo gitignores *.md, so the README next to
    // this file may not travel with it).
    const lines = fs.readFileSync(__filename, "utf8").split("\n").slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    console.log(lines.slice(0, end === -1 ? lines.length : end).join("\n"));
    return;
  }
  const errors = validate(opts);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[diagnostics] ${e}`);
    process.exitCode = 1;
    return;
  }

  const connection = describeConnection(process.env.DATABASE_URL);
  const generatedAt = new Date().toISOString();
  const head = repoHead();
  const outDir = path.resolve(opts.out);

  console.log("[diagnostics] inventory-accuracy Phase 0a — READ-ONLY");
  console.log(`[diagnostics] database: ${connection.host ?? "unknown"}/${connection.database ?? "unknown"}`);
  console.log(`[diagnostics] repo head: ${head ?? "unknown"}`);
  console.log(`[diagnostics] output:    ${outDir}`);
  console.log(`[diagnostics] checks:    ${opts.checks.join(", ")}`);

  const prisma = createClient();
  const ctx = { prisma, opts, connection, generatedAt, repoHead: head };
  const index = {
    check: "index",
    title: "Phase 0a diagnostic run",
    generatedAt,
    repoHead: head,
    connection,
    options: { ...opts, out: outDir },
    results: [],
  };

  try {
    for (const mod of MODULES) {
      const id = mod.check.slice(0, 2);
      if (!opts.checks.includes(id)) continue;
      const startedAt = Date.now();
      console.log(`[diagnostics] running ${mod.check} ...`);
      let outcome;
      try {
        const { sections, notes, meta } = await mod.run(ctx);
        const artifact = {
          check: mod.check,
          title: mod.title,
          purpose: mod.purpose,
          generatedAt,
          repoHead: head,
          connection,
          options: { ...opts, out: outDir },
          sections,
          notes: notes || [],
        };
        const paths = writeArtifact(outDir, artifact);
        outcome = {
          check: mod.check,
          status: "ok",
          durationMs: Date.now() - startedAt,
          meta: meta || {},
          jsonPath: paths.jsonPath,
          textPath: paths.textPath,
        };
        console.log(`[diagnostics]   -> ${paths.jsonPath}`);
        console.log(`[diagnostics]   -> ${paths.textPath}`);
      } catch (err) {
        outcome = {
          check: mod.check,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        };
        console.error(`[diagnostics] ${mod.check} FAILED: ${outcome.error}`);
        process.exitCode = 1;
      }
      index.results.push(outcome);
    }
  } finally {
    await prisma.$disconnect();
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "index.json"),
    `${JSON.stringify(index, jsonReplacer, 2)}\n`,
    "utf8"
  );
  console.log(`[diagnostics]   -> ${path.join(outDir, "index.json")}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[diagnostics] run failed:", err);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, validate, DEFAULTS, MODULES, CLASS_B_FLOOR_MODES };
