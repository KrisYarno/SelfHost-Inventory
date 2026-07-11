// @jest-environment node
/**
 * Change-tracking ROUTE COVERAGE enforcement (Phase A Task 7; spec §10 R-D9 "D10 harness").
 *
 * THE GATE: every API route that exposes a mutating HTTP method (POST/PUT/PATCH/DELETE)
 * must either RECORD its changes through `@/lib/change-tracking` or carry an explicit,
 * reasoned exemption below. Phase A2 (Tasks 8-12) and Phase B tighten this list toward
 * zero pending entries — when you migrate a route, you MUST delete its EXEMPT entry
 * (a migrated route left in EXEMPT fails the RECORDS ∩ EXEMPT = ∅ assertion).
 *
 * Mechanics (R-D9 hybrid, binding):
 *  1. DISCOVERY  — recursive fs walk for route.ts files under app/api; each file is require()d
 *     under the mock harness below (extended from read-path-isolation.test.ts) and its
 *     mutating surface detected at RUNTIME: typeof mod.POST/PUT/PATCH/DELETE === "function".
 *     This catches `export const POST = apiHandler(...)`, re-exports, and wrappers that a
 *     source grep would misread.
 *  2. CLASSIFICATION — a route RECORDS iff its SOURCE TEXT contains "@/lib/change-tracking"
 *     AND a real call token /\brecordChange\s*\(/ or /\brecordIngestion\s*\(/.
 *     IMPORTANT: importing the module is NOT enough — routes that import it for READ
 *     functions only (e.g. admin/audit-logs uses getAuditLogs/getBatchLogs) must NOT
 *     classify as RECORDS; they need their own exemption if they expose a mutating method.
 *  3. ASSERT — mutating ⊆ RECORDS ∪ EXEMPT, and RECORDS ∩ EXEMPT = ∅.
 *
 * Prisma is mocked (jest-mock-extended deep mock) — no real DB. Handlers are never
 * invoked; modules only need to LOAD under the harness.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mock harness — copied from __tests__/integration/read-path-isolation.test.ts
// and extended (see "EXTENSIONS" below) so that ALL app/api/**/route.ts modules
// can be require()d without side effects.
// ---------------------------------------------------------------------------

// --- Prisma: deep mock so any model access at module scope is a jest.fn().
jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

// --- Keep the REAL apiHandler (routes call it at module load to build their
// exports — the returned wrapper is what typeof-detection sees); stub guards.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
    requireAdmin: jest.fn(),
  };
});

// --- Side-effect libs the routes touch but never at module-load decision points.
jest.mock("@/lib/csrf", () => {
  const actual = jest.requireActual("@/lib/csrf");
  return {
    __esModule: true,
    ...actual,
    validateCSRFToken: jest.fn(async () => true),
  };
});

jest.mock("@/lib/rateLimit", () => {
  const actual = jest.requireActual("@/lib/rateLimit");
  return {
    __esModule: true,
    ...actual,
    enforceRateLimit: jest.fn(() => ({})),
    applyRateLimitHeaders: jest.fn((resp: unknown) => resp),
  };
});

// Deprecated legacy audit service (deleted by Task 14 — when lib/audit.ts goes,
// remove this jest.mock line too; routes will no longer import it).

jest.mock("@/lib/email", () => ({
  __esModule: true,
  emailService: {
    generateWeeklyReportHTML: jest.fn(() => "<html></html>"),
    generateWeeklyReportText: jest.fn(() => "text"),
    sendEmail: jest.fn(async () => undefined),
  },
}));

jest.mock("@/lib/staging/graduate", () => ({
  graduateStagingItem: jest.fn(),
}));

// --- EXTENSIONS beyond the read-path-isolation set -------------------------

// jest.setup.js mocks "next-auth" as { getServerSession } — NOT callable. The
// app/api/auth/[...nextauth] route calls NextAuth(authOptions) at MODULE LOAD,
// so this file overrides with a callable default that returns a handler fn
// (which is exactly what the route re-exports as GET/POST).
jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(() => async function nextAuthHandler() {}),
  getServerSession: jest.fn(),
}));

// Some routes import getServerSession from "next-auth/next" instead.
jest.mock("next-auth/next", () => ({
  __esModule: true,
  getServerSession: jest.fn(),
}));

// The module under enforcement: mocked so this test is independent of its
// implementation (classification is SOURCE-TEXT, never runtime behavior).
jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  recordIngestion: jest.fn(async () => true),
  newBatchId: jest.fn(() => "00000000-0000-4000-8000-000000000000"),
  normalizeEntityId: jest.fn((id: unknown) => (id == null ? null : String(id))),
  redactDeep: jest.fn(<T,>(v: T) => v),
  diff: jest.fn(() => ({})),
  getAuditLogs: jest.fn(async () => ({ logs: [], total: 0 })),
  COMPANY_SCOPED_ENTITY_TYPES: new Set(),
  REDACTED_KEYS: [],
}));

// ---------------------------------------------------------------------------
// Exemption registry
// ---------------------------------------------------------------------------

interface Exemption {
  path: string; // repo-relative POSIX path to the route file
  reason: string;
}

/**
 * PERMANENT exemptions — mutating-by-HTTP-verb but by design never record
 * through change-tracking. Entries that are currently GET-only are seeded
 * DEFENSIVELY: if someone later adds a mutating verb, they stay exempt on
 * purpose (they are infrastructure, not business state).
 */
const PERMANENT_EXEMPT: Exemption[] = [
  {
    path: "app/api/auth/[...nextauth]/route.ts",
    reason: "NextAuth internals — signin/session machinery, not app business mutations",
  },
  {
    path: "app/api/admin/audit-logs/route.ts",
    reason:
      "read-only audit-log lookup (the batch-filter POST and getBatchLogs were " +
      "deleted in Lane 3 R-L8). Imports @/lib/change-tracking for the READ " +
      "function getAuditLogs only — a read-only importer must never classify as RECORDS",
  },
  {
    path: "app/api/cron/external-sync/route.ts",
    reason:
      "trigger-only cron wrapper (verified: delegates to lib/external-orders/sync); " +
      "recorded work lives in the invoked job via recordIngestion (Phase B, R-D2/R-D4)",
  },
  {
    path: "app/api/diagnostics/route.ts",
    reason: "diagnostics echo — POST returns the received body; no persistent state",
  },
  {
    path: "app/api/test/csrf/route.ts",
    reason: "test endpoint (CSRF round-trip echo); no persistent state",
  },
  {
    path: "app/api/test/email/route.ts",
    reason: "test endpoint (sends a canned test email); no persistent state",
  },
  {
    path: "app/api/test/sendgrid-debug/route.ts",
    reason: "test endpoint (SendGrid delivery debug); no persistent state",
  },
  {
    path: "app/api/csrf/route.ts",
    reason: "CSRF token mint (currently GET-only; defensively permanent)",
  },
  {
    path: "app/api/healthz/route.ts",
    reason: "liveness probe (currently GET-only; defensively permanent)",
  },
  {
    path: "app/api/placeholder/[width]/[height]/route.ts",
    reason: "static SVG placeholder generator (currently GET-only; defensively permanent)",
  },
  {
    path: "app/api/dev/db-stats/route.ts",
    reason: "dev-gated diagnostics (currently GET-only; defensively permanent)",
  },
  {
    path: "app/api/admin/stock-check/route.ts",
    reason:
      "trigger-only: delegates to lib/stock-checker, which writes only notificationHistory " +
      "dispatch rows (plumbing, not business state — R-D16 telemetry class)",
  },
  {
    path: "app/api/auth/resend-notification/route.ts",
    reason:
      "mutates no persistent state (currently a stub that also sends nothing — " +
      "registered in deferred-work.md)",
  },
  {
    path: "app/api/admin/integrations/[id]/price-sync/route.ts",
    reason:
      "trigger-only: delegates to lib/external-orders/price-sync, which records " +
      "per-product PRODUCT_UPDATE via recordChange in per-product transactions (Phase B, D10)",
  },
  {
    path: "app/api/admin/integrations/[id]/stock-sync/route.ts",
    reason:
      "trigger-only: lib/external-orders/stock-sync writes only Integration telemetry " +
      "fields (R-D16 EXEMPT-with-reason: plumbing, not business state)",
  },
  {
    path: "app/api/admin/integrations/[id]/sync/route.ts",
    reason:
      "trigger-only: delegates to lib/external-orders/sync, which records effective " +
      "order transitions via recordIngestion (Phase B, R-D4)",
  },
];

/**
 * PHASE-PENDING exemptions — real mutating routes that MUST migrate to
 * recordChange/recordIngestion. Tasks 8-12 (phase-A2) and Phase B REMOVE their
 * entries as they land. A stale entry (route migrated but still listed here)
 * fails the RECORDS ∩ EXEMPT = ∅ assertion; a removed-but-unmigrated route
 * fails the coverage assertion. Both directions are enforced.
 */
const PHASE_PENDING_EXEMPT: Exemption[] = [
  // --- Task 8: inventory group — MIGRATED (adjust/batch-adjust/deduct-simple/
  //     transfer/transfer-batch/mass-update now recordChange inside the
  //     stock-write transaction; stock-in absorbed here per the Task 7 seam, so
  //     its former phase-B entry is removed too; transfers is GET-only read-switch). ---
  // --- Task 9: products group — MIGRATED (create/update/delete/price-source/approve/decline now recordChange) ---
  // --- Task 10: staging/scratchpad group — MIGRATED (create/discard/graduate + scratchpad create/patch/delete now recordChange; graduation groups STAGING_GRADUATE + PRODUCT_CREATE under one batchId) ---
  // --- Task 11: users group — MIGRATED (all 6 admin/users routes now recordChange) ---
  // --- Task 12: orders group — MIGRATED (fulfill/unfulfill now recordChange) ---
  // --- Phase B: coverage closure (not in any A2 task group) ---
];

/**
 * CARVE_OUTS — modules whose import genuinely resists the mock harness.
 * MUST stay empty unless a route module cannot be loaded even after adding
 * mocks; each entry needs a specific reason naming the stubborn import.
 * (R-D9 allows the list; the plan requires it to start EMPTY.)
 */
const CARVE_OUTS: Exemption[] = [];

/**
 * PER-HANDLER exemptions — a RECORDS file whose named mutating handler does not
 * itself contain a record call. Same bookkeeping contract as PHASE_PENDING_EXEMPT:
 * fix the handler, delete the entry.
 */
interface HandlerExemption { path: string; method: (typeof MUTATING_METHODS)[number]; reason: string }
const HANDLER_EXEMPT: HandlerExemption[] = [];

// ---------------------------------------------------------------------------
// Discovery + classification
// ---------------------------------------------------------------------------

// D12 (GET blind spot — documented, not closed): this gate classifies MUTATING
// VERBS only. GET routes with side effects are invisible to it — known today:
// cron/stock-check + admin/stock-check's delegation into lib/stock-checker
// (notificationHistory rows), and the 3 DATA_EXPORT routes (inventory/export,
// admin/logs/export, mass-update/export) whose recording is enforced by Task 3's
// tests, not here. A verb-agnostic side-effect sweep is a Lane 5 roadmap item —
// Task 11 registers it in deferred-work.md.
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, "app", "api");

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function discoverRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...discoverRouteFiles(full));
    } else if (entry.isFile() && entry.name === "route.ts") {
      found.push(full);
    }
  }
  return found.sort();
}

/** Source-text RECORDS classifier (R-D9): import alone is NOT enough — a real
 *  call token is required, so read-only importers (getAuditLogs et al.) and
 *  type-only imports never count as recording. */
function recordsChanges(sourceText: string): boolean {
  return (
    sourceText.includes("@/lib/change-tracking") &&
    (/\brecordChange\s*\(/.test(sourceText) || /\brecordIngestion\s*\(/.test(sourceText))
  );
}

// ER-B5 (known limitation — documented, not engineered-away): the scan slices a
// route file at export boundaries, so a shared helper containing a record call
// that sits BETWEEN two exports lands in the PRECEDING handler's segment and can
// false-PASS it; it cannot false-FAIL a real recorder. Behavior is owned by the
// per-lane characterization tests; this gate is belt-and-suspenders. Lane writers
// keep record calls inside handler bodies (Global Constraints).
/** Split a route source into per-exported-handler segments. House style is
 *  `export const POST = apiHandler(...)` / `export async function POST(...)`;
 *  a segment runs from its export keyword to the next `export` or EOF. */
function handlerSegments(sourceText: string): Map<string, string> {
  const re = /^export\s+(?:const|async\s+function)\s+(POST|PUT|PATCH|DELETE|GET)\b/gm;
  const hits: Array<{ method: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText)) !== null) hits.push({ method: m[1], index: m.index });
  const segments = new Map<string, string>();
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : sourceText.length;
    segments.set(h.method, sourceText.slice(h.index, end));
  });
  return segments;
}

interface RouteAnalysis {
  routeFiles: string[]; // repo-relative
  mutating: Map<string, string[]>; // repo path -> mutating methods exported
  records: Set<string>; // repo paths classified as RECORDS
  loadFailures: Array<{ path: string; error: string }>;
}

let analysis: RouteAnalysis;

jest.setTimeout(180_000);

beforeAll(() => {
  const carveOutPaths = new Set(CARVE_OUTS.map((c) => c.path));
  const result: RouteAnalysis = {
    routeFiles: [],
    mutating: new Map(),
    records: new Set(),
    loadFailures: [],
  };

  for (const abs of discoverRouteFiles(API_DIR)) {
    const repoPath = toRepoPath(abs);
    result.routeFiles.push(repoPath);

    // (2) source-text classification — never runtime.
    if (recordsChanges(fs.readFileSync(abs, "utf8"))) {
      result.records.add(repoPath);
    }

    // (1) runtime import + typeof detection of the mutating surface.
    if (carveOutPaths.has(repoPath)) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(abs);
      const methods = MUTATING_METHODS.filter((m) => typeof mod[m] === "function");
      if (methods.length > 0) result.mutating.set(repoPath, methods);
    } catch (err) {
      result.loadFailures.push({
        path: repoPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  analysis = result;
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe("change-tracking route coverage (R-D9 / D10 enforcement gate)", () => {
  it("discovers a sane route surface (guards against discovery rot)", () => {
    expect(analysis.routeFiles.length).toBeGreaterThanOrEqual(80);
    expect(analysis.mutating.size).toBeGreaterThanOrEqual(40);
  });

  it("loads every route module under the mock harness (carve-outs must be declared)", () => {
    const failures = analysis.loadFailures
      .map((f) => `  ${f.path}\n    -> ${f.error}`)
      .join("\n");
    expect(
      analysis.loadFailures.length === 0
        ? ""
        : `Route modules failed to require() under the mock harness — extend the jest.mock set\n` +
            `in this file first; only add a CARVE_OUTS entry (with the stubborn import named)\n` +
            `if mocking is genuinely impossible:\n${failures}`
    ).toBe("");
  });

  it("every mutating route records changes or carries an explicit exemption", () => {
    const exemptPaths = new Set(
      [...PERMANENT_EXEMPT, ...PHASE_PENDING_EXEMPT, ...CARVE_OUTS].map((e) => e.path)
    );
    const uncovered = Array.from(analysis.mutating.entries())
      .filter(([p]) => !analysis.records.has(p) && !exemptPaths.has(p))
      .map(([p, methods]) => `  ${p} [${methods.join(", ")}]`);

    expect(
      uncovered.length === 0
        ? ""
        : `Mutating routes with NO change-tracking and NO exemption. Either call\n` +
            `recordChange(tx, ...) / recordIngestion(...) inside the route's transaction, or add\n` +
            `an EXEMPT entry with a reviewed reason to change-tracking-coverage.test.ts:\n` +
            uncovered.join("\n")
    ).toBe("");
  });

  it("no route is both RECORDS and EXEMPT (migrated routes must leave the EXEMPT list)", () => {
    const all = [...PERMANENT_EXEMPT, ...PHASE_PENDING_EXEMPT];
    const stale = all
      .filter((e) => analysis.records.has(e.path))
      .map((e) => `  ${e.path} (listed as: ${e.reason})`);

    expect(
      stale.length === 0
        ? ""
        : `Routes now RECORD through @/lib/change-tracking but are still EXEMPT — delete\n` +
            `their entries from change-tracking-coverage.test.ts:\n` +
            stale.join("\n")
    ).toBe("");
  });

  it("every mutating handler inside a RECORDS file records (per-handler gate)", () => {
    const exemptKey = new Set(HANDLER_EXEMPT.map((e) => `${e.path}#${e.method}`));
    const gaps: string[] = [];
    for (const [repoPath, methods] of Array.from(analysis.mutating)) {
      if (!analysis.records.has(repoPath)) continue; // file-level gate covers non-RECORDS files
      const source = fs.readFileSync(path.join(REPO_ROOT, repoPath), "utf8");
      const segments = handlerSegments(source);
      for (const method of methods) {
        const segment = segments.get(method) ?? "";
        const records = /\brecordChange\s*\(/.test(segment) || /\brecordIngestion\s*\(/.test(segment);
        if (!records && !exemptKey.has(`${repoPath}#${method}`)) {
          gaps.push(`  ${repoPath} [${method}]`);
        }
      }
    }
    expect(
      gaps.length === 0
        ? ""
        : `Handlers inside RECORDS files that do not record — record inside the handler's\n` +
          `transaction or add a HANDLER_EXEMPT entry:\n` + gaps.join("\n")
    ).toBe("");
  });

  it("EXEMPT hygiene: entries are unique, point at real files, and phase-pending entries are still mutating", () => {
    const all = [...PERMANENT_EXEMPT, ...PHASE_PENDING_EXEMPT, ...CARVE_OUTS];

    // No duplicate paths across the lists.
    const seen = new Set<string>();
    const dupes = all.filter((e) => (seen.has(e.path) ? true : (seen.add(e.path), false)));
    expect(dupes.map((d) => d.path)).toEqual([]);

    // Every entry names an existing route file (stale paths rot the gate).
    const missing = all.filter((e) => !fs.existsSync(path.join(REPO_ROOT, e.path)));
    expect(missing.map((m) => m.path)).toEqual([]);

    // Every entry has a non-empty reason.
    const unreasoned = all.filter((e) => !e.reason || e.reason.trim().length === 0);
    expect(unreasoned.map((u) => u.path)).toEqual([]);

    // PHASE-PENDING entries must still expose a mutating method — if a route
    // stopped mutating (or was deleted/renamed), its entry is stale noise.
    const notMutating = PHASE_PENDING_EXEMPT.filter((e) => !analysis.mutating.has(e.path));
    expect(
      notMutating.length === 0
        ? ""
        : `PHASE-PENDING exemptions for routes that no longer export a mutating method —\n` +
            `remove these stale entries:\n` +
            notMutating.map((e) => `  ${e.path}`).join("\n")
    ).toBe("");

    // HANDLER_EXEMPT hygiene: every entry points at a real file, its method is
    // among the file's detected mutating methods, and its reason is non-empty.
    const handlerMissing = HANDLER_EXEMPT.filter((e) => !fs.existsSync(path.join(REPO_ROOT, e.path)));
    expect(handlerMissing.map((e) => e.path)).toEqual([]);

    const handlerUnreasoned = HANDLER_EXEMPT.filter((e) => !e.reason || e.reason.trim().length === 0);
    expect(handlerUnreasoned.map((e) => e.path)).toEqual([]);

    const handlerNotMutating = HANDLER_EXEMPT.filter(
      (e) => !(analysis.mutating.get(e.path) ?? []).includes(e.method)
    );
    expect(
      handlerNotMutating.length === 0
        ? ""
        : `HANDLER_EXEMPT entries whose method is not a detected mutating method of the file —\n` +
            `remove these stale entries:\n` +
            handlerNotMutating.map((e) => `  ${e.path} [${e.method}]`).join("\n")
    ).toBe("");
  });

  it("CARVE_OUTS remains the exception, not the rule", () => {
    // The list starts EMPTY (plan Task 7). If an entry is ever added, it must
    // carry a reason naming the stubborn import — reviewed, not convenient.
    for (const c of CARVE_OUTS) {
      expect(c.reason).toMatch(/import|module|require/i);
    }
    expect(CARVE_OUTS.length).toBeLessThanOrEqual(3);
  });
});
