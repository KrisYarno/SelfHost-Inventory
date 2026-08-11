/**
 * launch-gate/matrix-completeness.test.ts — THE META-CHECK (plan Task 3.3 part B;
 * spec C7's assertion matrix; contract pack REV-7 "CHECKSUM_MANIFEST is hand-
 * maintained ... 3.3's completeness meta-check must assert it against schema.prisma").
 *
 * Every other file in this project asserts that the product does what it says. This
 * one asserts that THE GATE ITSELF is complete — the failure mode nobody else can see:
 *
 *   1. A spec C7 matrix row with no describe behind it. The suite would be green and
 *      the row would be unproven, and the only witness would be a human comparing a
 *      920-line spec against 3,000 lines of tests by eye.
 *   2. A describe nobody registered. New coverage is welcome; UNCLAIMED coverage means
 *      the map and the territory have started drifting, and the map is what the wave
 *      close reads.
 *   3. A business table missing from `CHECKSUM_MANIFEST`. Row 6 ("zero business
 *      writes") is only as strong as its manifest, the manifest is HAND-MAINTAINED,
 *      and a table added by a future migration would simply never be checked. That is
 *      a silent hole in the lane's central safety claim, so it is asserted against
 *      `prisma/schema.prisma` AND against the live database's own table list.
 *
 * BOTH DIRECTIONS, and the checks are PURE FUNCTIONS with negative controls: a
 * completeness check that cannot be shown to fail is itself the thing it warns about.
 *
 * WHY THE ROWS ARE TRANSCRIBED HERE: `docs/` is gitignored (repo .gitignore:87), so
 * the spec is not present in a fresh checkout, and a CI-blocking gate may not depend
 * on a file that CI does not have. The registry below is therefore the transcription —
 * the same posture as every other spec quotation in this project — and the spec is
 * cross-checked verbatim WHEN it is on disk, which is every developer machine where
 * the gate is actually run before a wave close.
 */

import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { CHECKSUM_EXEMPT, CHECKSUM_MANIFEST, oracleQuery } from "./oracle";
import { GATE_DB_NAME } from "./state";

const LAUNCH_GATE_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const SPEC_PATH = path.join(
  REPO_ROOT,
  "docs",
  "superpowers",
  "specs",
  "2026-08-07-assistant-multiuser-spec.md",
);
const TEARDOWN_PATH = path.join(LAUNCH_GATE_DIR, "global-teardown.ts");
const JEST_CONFIG_PATH = path.join(LAUNCH_GATE_DIR, "jest.config.mjs");

// ---------------------------------------------------------------------------
// The registry (transcribed from spec C7's assertion matrix, REV-13)
// ---------------------------------------------------------------------------

type RowCoverage = {
  /** The spec's own row id: "1", "2", "2a".."2m", "3", "4", "5", "6". */
  row: string;
  /** The row's claim, in the spec's words (abbreviated where it is a paragraph). */
  claim: string;
  /** Describe titles that carry it. Nested titles are allowed (2a-2m are nested). */
  describes: string[];
  /** Rows whose home is the D8 bracket rather than a test file (row 6). */
  bracket?: string;
};

const MATRIX_COVERAGE: RowCoverage[] = [
  {
    row: "1",
    claim: "Membership scoping: memberA sees ONLY A sentinels; zeroUser hard isolation; admin exactly A+B; ZERO B-sentinel leakage",
    describes: ["MATRIX ROW 1 — membership scoping through the REAL route"],
  },
  {
    row: "2",
    claim: "Post-lane contracts via the REAL route — one row per amendment item",
    describes: ["MATRIX ROW 2 — post-lane tool contracts through the REAL route"],
  },
  {
    row: "2a",
    claim: "scope echoes (productScope/filters/scope)",
    describes: ["2a — effective-scope / filter echoes (C4)"],
  },
  {
    row: "2b",
    claim: "reorder coverage invariant sweep incl. productIds/includeHealthy semantics + requested accounting",
    describes: ["2b — reorder coverage invariant + productIds/includeHealthy semantics (C5/C11)"],
  },
  {
    row: "2c",
    claim: "salesDataStart / windowCoverage incl. the FD2-2 per-company degradation company",
    describes: ["2c — salesDataStart / windowCoverage incl. the no-sales-company degradation (C6/FD2-2)"],
  },
  {
    row: "2d",
    claim: "periodCoverage + coverageShift on BOTH compare modes",
    describes: ["2d — periodCoverage + coverageShift on BOTH compare modes (C9/FD3-3)"],
  },
  {
    row: "2e",
    claim: "compare by_product ranked/unranked split",
    describes: ["2e — compare by_product ranked / unranked split (C9)"],
  },
  {
    row: "2f",
    claim: "movement modes incl. by_product batch + rejected-id echoes",
    describes: ["2f — movement modes incl. the by_product batch + rejected-id echoes (C10)"],
  },
  {
    row: "2g",
    claim: "outbound-mix values — the negative-STOCK_IN and CORRECTION fixtures move exactly their scripted buckets",
    describes: ["2g — outbound-mix values: the seeded fixtures move EXACTLY their buckets (C12)"],
  },
  {
    row: "2h",
    claim: "sales-coverage totalOrders denominator + attributionNote",
    describes: ["2h — sales-coverage totalOrders denominator + attributionNote (C7)"],
  },
  {
    row: "2i",
    claim: "rawThreshold-derived thresholdSource (override == default case)",
    describes: ["2i — low_stock thresholdSource from the RAW value, incl. override == default (C8)"],
  },
  {
    row: "2j",
    claim: "includeZeroRows zero-vs-null truth table",
    describes: [
      "2j — includeZeroRows zero-vs-null truth table (C6)",
      // The fourth branch (pack REV-9 F-3) needed a fourth actor and therefore a
      // second home: a caller WITH companies and zero facts.
      "F-3 — a caller WITH companies and ZERO facts: the null-salesDataStart branch",
    ],
  },
  {
    row: "2k",
    claim: "lifecycle policy table (archived tagged in historical tools, absent from current-state tools; unapproved moves NO total, disclosed)",
    describes: ["2k — lifecycle + approval policy table (C13)"],
  },
  {
    row: "2l",
    claim: "G1 misuse rejections surface as `hint`",
    describes: ["2l — G1 misuse rejections surface as `hint` through the REAL adapter"],
  },
  {
    row: "2m",
    claim: "definition strings ride payloads",
    describes: ["2m — the C3 definition strings ride the payloads, verbatim"],
  },
  {
    row: "3",
    claim: "MCP member-token matrix: scoping subset via memberA's and admin's tokens; revoked token; lastUsedAt advances; MCP runs carry requestId NULL",
    describes: ["MATRIX ROW 3 — the MCP member-token matrix"],
  },
  {
    row: "4",
    claim:
      "Thread lifecycle: create-on-first-message, resume canonical-equal, ownership 404 matrix, THREAD_BUSY, two tabs, stop mid-stream/mid-tool, error rows, regenerate (incl. both retry cases and the 409), DELETE-while-busy, THE FENCE, the PROVIDER_TIMEOUT cases, history byte bound",
    describes: [
      "row 4 opens on a fresh app generation",
      "RESUME — the persisted transcript is canonical-equal to what streamed",
      "THREAD_BUSY — one writer per thread, and the DELETE that respects it",
      "TWO TABS on DIFFERENT threads stream concurrently",
      "REGENERATE — the four cases (spec C4's ONE anchor rule)",
      "F-5 fixed — a truncated provider stream is recorded error/PROVIDER_ERROR",
      "F-4 fixed — a dropped-turn history answers normally",
      "HISTORY BYTE BOUND — shedding, whole-turn drops and the omission note",
      "HISTORY BYTE BOUND — a big SHED-ONLY thread still answers over HTTP",
      // Spike B's proofs ARE row-4 rows: the spec keeps the fence "as a standing matrix
      // row" and puts both PROVIDER_TIMEOUT cases here (REV-8).
      "SPIKE B(a) — client disconnect mid-stream lands an `aborted` request row",
      "SPIKE B(b) — THE FENCE, module-level against the real gate database",
      "SPIKE B(d) — bounded finalization at the route-owned T2 deadline",
    ],
  },
  {
    row: "5",
    claim:
      "Telemetry: exact scripted usage, membershipScope snapshot, title rows with their own usage, the failed-title row shape, per-tool runs rows carry requestId, no-usage turns persist NULLs, dayKey is the UTC date of insertion",
    describes: [
      "MATRIX ROW 5 — request + run telemetry",
      "NULL usage is PRESERVED as NULL, never written as 0 (G2)",
      "title request rows (spec C6/C7 row 5)",
      "a FAILED title call is still attributed (spec C6)",
      "later-fallback makes NO model call (spec C6 / pack T6)",
    ],
  },
  {
    row: "6",
    claim:
      "Zero-business-writes: CHECKSUM over the business-table manifest before/after the FULL matrix, byte-identical except the exempt manifest (incl. api_tokens.lastUsedAt as the ONLY api_tokens delta)",
    // NOT a describe by design (plan cluster G / D8): a bracket that lived in a test
    // file would depend on jest's file ORDER. It opens in globalSetup and closes in
    // globalTeardown, and its manifest is asserted complete further down this file.
    describes: [],
    bracket: "global-teardown.ts",
  },
];

/**
 * The W3 ride-along (spec C9's "Launch-gate ride-along (W3)" bullet + contract pack
 * REV-17's registered usage-API item). Not C7 matrix rows — a separate, equally
 * registered family, so the reverse direction can tell "new coverage" from "coverage
 * nobody wrote down".
 */
const RIDE_ALONG_COVERAGE: RowCoverage[] = [
  {
    row: "C9-report",
    claim: "report POST writes the row with full turns + caps honored",
    describes: [
      "C9 REPORT — the full persisted transcript crosses, through the REAL route",
      "C9 REPORT — truthful degradation at the 2 MB cap (declared fixture)",
      "C9 REPORT — overflow answers 413 and writes NO ROW (spec REV-9)",
    ],
  },
  {
    row: "C9-ownership",
    claim: "ownership 404 on foreign threads",
    describes: ["C9 REPORT — ownership is absolute and the 404 is not an existence oracle"],
  },
  {
    row: "C9-ratelimit",
    claim: "rate limit enforced (5/hr) — with the CSRF guard that precedes it",
    describes: ["C9 REPORT — CSRF, then the house 5/hr limiter (spec C9)"],
  },
  {
    row: "C9-export",
    claim: "export round-trips byte-identical (G2-12)",
    describes: ["C9 EVAL — upload, read-back, and the export ROUND TRIP at the HTTP layer"],
  },
  {
    row: "C8-usage",
    claim:
      "pack REV-17: the C8 groupBy's COUNT(*)-vs-COUNT(col) SQL was MySQL-unproven — 3.3 drives a turn and asserts the rollup against the oracle",
    describes: ["C8 USAGE — the ONE groupBy, adjudicated by REAL MySQL (pack REV-17)"],
  },
];

/**
 * Top-level describes that are deliberately NOT matrix rows. Each carries its reason:
 * an entry here is a claim that this coverage exists for a different purpose, not a
 * place to park a describe that should have been registered above.
 */
const NON_MATRIX_DESCRIBES: Array<{ title: string; why: string }> = [
  { title: "choreography loader (seam S8)", why: "harness infra exit (1.5), not a product row" },
  { title: "harness infrastructure", why: "harness infra exit (1.5)" },
  { title: "one trivial scripted turn through the REAL route", why: "harness infra exit (1.5)" },
  {
    title: "SPIKE A — shim wire fidelity through ai-sdk-ollama",
    why: "W1 go/no-go spike (spec C7 Spike A) — feasibility, not an assertion row",
  },
  {
    title: "SPIKE B(c) — the crash path: SIGKILL, restart, lease, fence",
    why: "W1 go/no-go spike (spec C7 Spike B(c)) — the crash path is a spike proof; the fence ROW is B(b)",
  },
  {
    title: "THE CLIENT WIRE — the exact body prepareSendMessagesRequest emits",
    why: "2.4a matrix extension (pack REV-14) — a T7 wire replica, outside the C7 rows",
  },
  {
    title: "RESUME COMPOSITION — the client mounts the FILTERED mapping, not the response",
    why: "2.4a matrix extension (pack REV-14) — a 2.2 client-mapping replica, outside the C7 rows",
  },
  {
    title: "COMPLETENESS — every spec C7 matrix row has a describe in this project",
    why: "the meta-check itself (Task 3.3)",
  },
  {
    title: "COMPLETENESS — every describe in this project is claimed by a registered row",
    why: "the meta-check itself (Task 3.3)",
  },
  {
    title: "COMPLETENESS — CHECKSUM_MANIFEST covers every table (row 6's precondition)",
    why: "the meta-check itself (Task 3.3)",
  },
];

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

const DESCRIBE_ANYWHERE = /(?<![.\w])describe\(\s*"((?:[^"\\]|\\.)*)"/g;
const DESCRIBE_TOP_LEVEL = /^describe\(\s*"((?:[^"\\]|\\.)*)"/gm;

function unescape(literal: string): string {
  return literal.replace(/\\(.)/g, "$1");
}

/**
 * W3S-4: the scan must see only ACTIVE code — a describe commented out wholesale
 * would otherwise keep satisfying the evidence check while jest no longer runs it.
 * Line and block comments are stripped BEFORE matching; string literals in these
 * test files never contain `//` or `/*` sequences that would confuse this (and the
 * permanent controls below would catch a regression in that assumption via their
 * active-describe expectations).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The describes really ACTIVE in one source text (comment-stripped; `.skip` and
 *  other property-call forms excluded by the lookbehind). Exported to the controls. */
function describesInSource(source: string): string[] {
  const found: string[] = [];
  for (const match of Array.from(stripComments(source).matchAll(DESCRIBE_ANYWHERE))) {
    found.push(unescape(match[1]));
  }
  return found;
}

function testFiles(): string[] {
  return fs
    .readdirSync(LAUNCH_GATE_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

function collectDescribes(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of testFiles()) {
    const source = stripComments(fs.readFileSync(path.join(LAUNCH_GATE_DIR, file), "utf8"));
    // `Array.from`, not `for..of` over the iterator: the ROOT tsconfig (which is what
    // `npx tsc --noEmit` checks this directory with) targets below ES2015.
    for (const match of Array.from(source.matchAll(pattern))) found.push(unescape(match[1]));
  }
  return found;
}

const ALL_DESCRIBES = collectDescribes(DESCRIBE_ANYWHERE);
const TOP_LEVEL_DESCRIBES = collectDescribes(DESCRIBE_TOP_LEVEL);

// ---------------------------------------------------------------------------
// The checks, as pure functions (so the negative controls can drive them)
// ---------------------------------------------------------------------------

/** Rows whose registered evidence is absent from the project's sources. */
export function missingEvidence(rows: RowCoverage[], describes: string[]): string[] {
  const present = new Set(describes);
  const violations: string[] = [];
  for (const row of rows) {
    if (row.describes.length === 0 && row.bracket === undefined) {
      violations.push(`row ${row.row} registers NO evidence at all`);
      continue;
    }
    for (const title of row.describes) {
      if (!present.has(title)) {
        violations.push(`row ${row.row} names a describe that does not exist: ${JSON.stringify(title)}`);
      }
    }
  }
  return violations;
}

/** Top-level describes no registry entry claims (and claims made twice). */
export function claimViolations(topLevel: string[], rows: RowCoverage[], allowed: string[]): string[] {
  const claims = new Map<string, string[]>();
  for (const row of rows) {
    for (const title of row.describes) {
      claims.set(title, [...(claims.get(title) ?? []), `row ${row.row}`]);
    }
  }
  for (const title of allowed) {
    claims.set(title, [...(claims.get(title) ?? []), "non-matrix"]);
  }
  const violations: string[] = [];
  for (const title of topLevel) {
    const owners = claims.get(title);
    if (owners === undefined) {
      violations.push(`describe ${JSON.stringify(title)} is claimed by NO registered row`);
    } else if (owners.length > 1) {
      violations.push(`describe ${JSON.stringify(title)} is claimed twice: ${owners.join(" + ")}`);
    }
  }
  return violations;
}

/**
 * The row-6 manifest check. `tables` is the ground truth (schema.prisma's mapped table
 * names, or the live database's); a table must be digested by the manifest or exempt
 * WHOLESALE, and never both.
 */
export function manifestViolations(
  tables: string[],
  manifest: string[],
  exempt: { table: string; columns?: string[] }[],
  source: string,
): string[] {
  const wholesale = exempt.filter((entry) => entry.columns === undefined).map((entry) => entry.table);
  const partial = exempt.filter((entry) => entry.columns !== undefined).map((entry) => entry.table);
  const covered = new Set([...manifest, ...wholesale]);
  const violations: string[] = [];

  for (const table of tables) {
    if (!covered.has(table)) {
      violations.push(
        `${source} has table "${table}" which is NEITHER in CHECKSUM_MANIFEST nor exempt — ` +
          "row 6 would never look at it",
      );
    }
  }
  const known = new Set(tables);
  for (const table of [...manifest, ...wholesale]) {
    if (!known.has(table)) {
      violations.push(`CHECKSUM_MANIFEST/CHECKSUM_EXEMPT names "${table}", absent from ${source}`);
    }
  }
  for (const table of manifest) {
    if (wholesale.includes(table)) {
      violations.push(`"${table}" is in the manifest AND wholesale-exempt — one of them is a lie`);
    }
  }
  for (const table of partial) {
    if (!manifest.includes(table)) {
      violations.push(`"${table}" has a COLUMN exemption but is not digested at all`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Ground truths
// ---------------------------------------------------------------------------

/** `@@map("x")` when present, else the model name (`inventory_logs`,
 *  `product_locations` are already snake_case models with no map). */
export function schemaTables(schema: string): string[] {
  const tables: string[] = [];
  const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of Array.from(schema.matchAll(modelPattern))) {
    const mapped = /@@map\("([^"]+)"\)/.exec(match[2]);
    tables.push(mapped === null ? match[1] : mapped[1]);
  }
  return tables.sort();
}

/** The spec's C7 row ids, or null when `docs/` is not in this checkout. */
export function readSpecMatrixRows(): string[] | null {
  if (!fs.existsSync(SPEC_PATH)) return null;
  const text = fs.readFileSync(SPEC_PATH, "utf8");
  const start = text.indexOf("**Assertion matrix");
  const end = text.indexOf("**Determinism:**", start);
  if (start === -1 || end === -1) {
    throw new Error(
      "the spec is present but its C7 assertion matrix could not be located " +
        '(looked for "**Assertion matrix" ... "**Determinism:**") — the transcription in ' +
        "this file can no longer be cross-checked, which is itself the finding",
    );
  }
  const ids: string[] = [];
  let current: string | null = null;
  const blocks = new Map<string, string[]>();
  const order: string[] = [];
  for (const line of text.slice(start, end).split("\n")) {
    const header = /^(\d+)\.\s+\*\*/.exec(line);
    if (header !== null) {
      current = header[1];
      order.push(current);
      blocks.set(current, []);
    }
    if (current !== null) blocks.get(current)?.push(line);
  }
  for (const row of order) {
    ids.push(row);
    // Sub-rows are the spec's own "(a) ... (m)" labels inside a row's paragraph.
    const subs = Array.from((blocks.get(row) ?? []).join(" ").matchAll(/\(([a-z])\)/g));
    for (const sub of subs) ids.push(`${row}${sub[1]}`);
  }
  return ids;
}

// ===========================================================================

describe("COMPLETENESS — every spec C7 matrix row has a describe in this project", () => {
  it("registers EXACTLY the spec's own C7 rows (or states that the spec is not in this checkout)", () => {
    const specRows = readSpecMatrixRows();
    const registered = MATRIX_COVERAGE.map((row) => row.row);
    if (specRows === null) {
      // `docs/` is gitignored (.gitignore:87), so a fresh clone has no spec to parse.
      // The branch is ASSERTED, not assumed: this passes only when the file really is
      // absent, and on every machine that has it the comparison below runs for real.
      expect(fs.existsSync(SPEC_PATH)).toBe(false);
      console.log(
        "[launch-gate] completeness: spec cross-check SKIPPED — docs/ is gitignored and this " +
          "checkout has no spec file. The registry in matrix-completeness.test.ts is the " +
          "transcription of record.",
      );
      return;
    }
    expect(registered).toEqual(specRows);
  });

  it("has real evidence behind every registered row", () => {
    expect(missingEvidence(MATRIX_COVERAGE, ALL_DESCRIBES)).toEqual([]);
  });

  it("has real evidence behind every W3 ride-along row (spec C9 / pack REV-17)", () => {
    expect(missingEvidence(RIDE_ALONG_COVERAGE, ALL_DESCRIBES)).toEqual([]);
  });

  it("row 6 lives in the D8 bracket, and the bracket is really wired", () => {
    const row6 = MATRIX_COVERAGE.find((row) => row.row === "6");
    expect(row6?.bracket).toBe("global-teardown.ts");
    const teardown = fs.readFileSync(TEARDOWN_PATH, "utf8");
    // The three calls that MAKE it a bracket: read the baseline, recompute, compare.
    expect(teardown).toContain("readChecksumBaseline");
    expect(teardown).toContain("manifestDigests");
    expect(teardown).toContain("compareDigests");
    // And a teardown jest never runs is not a bracket either.
    expect(fs.readFileSync(JEST_CONFIG_PATH, "utf8")).toContain("globalTeardown");
  });

  it("CONTROL: an absent row IS detected (the check can fail)", () => {
    const withGap: RowCoverage[] = [
      { row: "7", claim: "a row nobody wrote a test for", describes: ["a describe that does not exist"] },
      { row: "8", claim: "a row with no evidence at all", describes: [] },
    ];
    const violations = missingEvidence(withGap, ALL_DESCRIBES);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("row 7 names a describe that does not exist");
    expect(violations[1]).toContain("row 8 registers NO evidence at all");
  });

  // W3S-4: a raw-text scan reads COMMENTS too — a describe commented out wholesale
  // would keep satisfying the evidence check while jest no longer runs it. The
  // scanner must strip comments first, and these controls keep it that way.
  it("CONTROL W3S-4: a commented-out describe is NOT evidence", () => {
    const source = [
      '// describe("a block someone disabled", () => {});',
      '/* describe("a block inside a black comment", () => {}); */',
      'describe("a block that is really active", () => {});',
    ].join("\n");
    const titles = describesInSource(source);
    expect(titles).toEqual(["a block that is really active"]);
  });

  it("CONTROL W3S-4: describe.skip is NOT evidence either", () => {
    const source = 'describe.skip("a block someone parked", () => {});';
    expect(describesInSource(source)).toEqual([]);
  });
});

describe("COMPLETENESS — every describe in this project is claimed by a registered row", () => {
  const registry = [...MATRIX_COVERAGE, ...RIDE_ALONG_COVERAGE];
  const allowed = NON_MATRIX_DESCRIBES.map((entry) => entry.title);

  it("leaves no top-level describe unclaimed and none claimed twice", () => {
    expect(claimViolations(TOP_LEVEL_DESCRIBES, registry, allowed)).toEqual([]);
  });

  it("scans every test file in the project (the scan itself is not vacuous)", () => {
    const files = testFiles();
    expect(files).toContain("matrix-reports.test.ts");
    expect(files).toContain("matrix-completeness.test.ts");
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(TOP_LEVEL_DESCRIBES.length).toBeGreaterThanOrEqual(30);
    // Nested describes are found too — 2a-2m live one level down.
    expect(ALL_DESCRIBES.length).toBeGreaterThan(TOP_LEVEL_DESCRIBES.length);
  });

  it("every non-matrix describe carries a REASON, and still exists", () => {
    const present = new Set(TOP_LEVEL_DESCRIBES);
    for (const entry of NON_MATRIX_DESCRIBES) {
      expect(entry.why.length).toBeGreaterThan(10);
      expect(present.has(entry.title)).toBe(true);
    }
  });

  it("CONTROL: an unregistered describe IS detected", () => {
    const violations = claimViolations([...TOP_LEVEL_DESCRIBES, "a brand new unregistered describe"], registry, allowed);
    expect(violations).toEqual([
      'describe "a brand new unregistered describe" is claimed by NO registered row',
    ]);
  });
});

describe("COMPLETENESS — CHECKSUM_MANIFEST covers every table (row 6's precondition)", () => {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  const declared = schemaTables(schema);

  it("parses the schema's tables (the ground truth is real)", () => {
    // The parse must find models with AND without `@@map` — the two unmapped models are
    // exactly the ones a naive `@@map`-only parser would miss.
    expect(declared).toContain("inventory_logs");
    expect(declared).toContain("product_locations");
    expect(declared).toContain("assistant_eval_reports");
    expect(declared.length).toBeGreaterThanOrEqual(35);
  });

  it("manifest + exempt == prisma/schema.prisma's tables, exactly (pack REV-7)", () => {
    expect(manifestViolations(declared, CHECKSUM_MANIFEST, CHECKSUM_EXEMPT, "prisma/schema.prisma")).toEqual([]);
  });

  it("manifest + exempt == the LIVE gate database's tables, exactly", async () => {
    const rows = await oracleQuery<{ TABLE_NAME: string }>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
      [GATE_DB_NAME],
    );
    // `_prisma_migrations` is prisma's own ledger, created by `migrate deploy` and
    // declared by no model — the ONE table that is legitimately outside both lists.
    const live = rows
      .map((row) => row.TABLE_NAME)
      .filter((name) => name !== "_prisma_migrations")
      .sort();
    expect(live.length).toBeGreaterThan(0);
    // A migration that creates a table the schema never declared would pass the check
    // above and fail here; that is the reason both exist.
    expect(manifestViolations(live, CHECKSUM_MANIFEST, CHECKSUM_EXEMPT, "the live gate database")).toEqual([]);
    expect(live).toEqual(declared);
  });

  it("CONTROL: a table missing from the manifest IS detected", () => {
    const gapped = CHECKSUM_MANIFEST.filter((table) => table !== "locations");
    const violations = manifestViolations(declared, gapped, CHECKSUM_EXEMPT, "prisma/schema.prisma");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('table "locations" which is NEITHER in CHECKSUM_MANIFEST nor exempt');
  });

  it("CONTROL: a manifest entry for a table that no longer exists IS detected", () => {
    const stale = [...CHECKSUM_MANIFEST, "table_that_was_dropped"];
    const violations = manifestViolations(declared, stale, CHECKSUM_EXEMPT, "prisma/schema.prisma");
    expect(violations).toEqual([
      'CHECKSUM_MANIFEST/CHECKSUM_EXEMPT names "table_that_was_dropped", absent from prisma/schema.prisma',
    ]);
  });

  it("CONTROL: a column exemption on an undigested table IS detected", () => {
    const violations = manifestViolations(
      declared,
      CHECKSUM_MANIFEST.filter((table) => table !== "api_tokens"),
      CHECKSUM_EXEMPT,
      "prisma/schema.prisma",
    );
    expect(violations).toEqual([
      'prisma/schema.prisma has table "api_tokens" which is NEITHER in CHECKSUM_MANIFEST nor exempt — ' +
        "row 6 would never look at it",
      '"api_tokens" has a COLUMN exemption but is not digested at all',
    ]);
  });
});
