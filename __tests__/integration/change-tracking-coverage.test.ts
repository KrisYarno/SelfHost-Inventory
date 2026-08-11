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

// Lane 4: ai@7 and the @ai-sdk/* providers are ESM-only ("type":"module") and
// resist the CJS require this harness uses to load route modules. Mocking the
// package AND the provider-resolution module (whose import chain reaches the
// @ai-sdk packages) lets app/api/assistant/route.ts load and classify normally
// (its POST is PERMANENT_EXEMPT below).
jest.mock("ai", () => ({
  __esModule: true,
  streamText: jest.fn(),
  stepCountIs: jest.fn(() => () => false),
  convertToModelMessages: jest.fn(async () => []),
  tool: jest.fn((d: unknown) => d),
}));
jest.mock("@/lib/assistant/providers", () => ({
  __esModule: true,
  resolveSurfaceModel: jest.fn(async () => {
    throw new Error("unconfigured (mock)");
  }),
  validateSurfaceConfig: jest.fn(async () => undefined),
  PROVIDER_TIMEOUT_MS: 60_000,
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
  {
    // Multiuser substrate D9 (moved out of PHASE_PENDING 2026-08-10): the route now
    // writes assistant_threads / assistant_messages / assistant_requests, so the
    // honest reading is no longer "writes nothing" — it is that this is assistant
    // FEATURE state, not business state, and it is never migrating to recordChange.
    path: "app/api/assistant/route.ts",
    reason:
      "assistant feature state: threads/messages/requests are user-owned chat " +
      "persistence, not business state; zero business writes unchanged (the curated " +
      "tool layer stays read-only + assistant_runs telemetry). v1.1 mutation tools " +
      "will recordChange same-tx when they land — that is a TOOL-layer change, not " +
      "this route's.",
  },
  {
    // Multiuser substrate D9 (task 1.3): same rationale CLASS as the route above.
    // DELETE removes the caller's OWN thread (messages Cascade, requests SetNull so
    // usage attribution survives) — user-owned chat persistence, never business
    // state, and deliberately not audited in v1 (spec G4, registered).
    path: "app/api/assistant/threads/[id]/route.ts",
    reason:
      "assistant feature state: a user deleting their own thread removes chat " +
      "persistence, not business state; zero business writes unchanged (telemetry " +
      "rows survive via SetNull). Thread-mutation audit events are deliberately out " +
      "of scope for v1 — registered with the v1.1 write tools.",
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
  // --- Lane 4 (orchestrator, plan Global Constraints) ---
  {
    path: "app/api/admin/ai-providers/[kind]/test/route.ts",
    reason:
      "provider connectivity probe (verify-key / Ollama reachability) — POST by " +
      "verb but writes nothing; result is ephemeral verified/failed (spec D12).",
  },
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

// D12 (GET blind spot): the MUTATING-verb gate above classifies POST/PUT/PATCH/DELETE
// only, so GET routes with side effects are invisible to IT — but they are now covered by
// the GET_SIDE_EFFECT_REGISTRY gate at the bottom of this file (Lane 5 I7 + codex #13),
// which closes the former roadmap item. NOTE (corrected): admin/stock-check is a POST
// (a mutating trigger already handled by the verb gate + its PERMANENT_EXEMPT entry), NOT
// a GET blind spot. The GET side-effect surface is the 4 cron GETs (stock-check, stock-sync,
// weekly-report, analytics-rebuild) + the 4 DATA_EXPORT GETs (inventory/export,
// admin/logs/export, admin/inventory/mass-update/export, and admin/audit-logs/export —
// the 4th, previously omitted here). See the registry below for classifications.
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

// ---------------------------------------------------------------------------
// GET side-effect registry (Lane 5 I7 + codex #13) — closes the D12 GET blind spot.
//
// The verb gate above ignores GET. A GET handler can still cause side effects (cron
// triggers, DATA_EXPORT records). This registry names EVERY current side-effecting GET
// with a classification, and a sweep guards FUTURE GETs:
//
//  - EXEMPT           : machine triggers whose effects are telemetry/plumbing, not audited
//                       business state (the reason must say why).
//  - RECORDS_REQUIRED : GETs that MUST recordChange (DATA_EXPORT); their recording is
//                       characterized by change-tracking-admin-config.test.ts, not re-run here.
//
// Sweep heuristic (broadened per rev-2 — recordChange/recordIngestion + the side-effect lib
// families @/lib/email, @/lib/stock-checker, @/lib/external-orders/stock-sync,
// @/lib/analytics/rebuild-*). It is SEGMENT-AWARE: a side-effect signal only counts when it
// appears inside the file's GET handler segment, so a route whose recordChange lives in its
// POST/PUT/DELETE handler (the common GET+mutation route) is NOT a GET finding. Known limits:
// (a) a GET that reaches a side effect through a NON-broadened helper import is not detected;
// (b) segment slicing is export-boundary based (same limitation as the verb gate's
// handlerSegments). Add new side-effecting GETs to the registry (with a classification) or
// keep the side effect out of the GET handler.
// ---------------------------------------------------------------------------

interface GetSideEffect {
  path: string;
  kind: "EXEMPT" | "RECORDS_REQUIRED";
  reason: string;
}

const GET_SIDE_EFFECT_REGISTRY: GetSideEffect[] = [
  // --- the 4 cron GETs (machine triggers) ---
  {
    path: "app/api/cron/stock-check/route.ts",
    kind: "EXEMPT",
    reason:
      "machine trigger; telemetry via NotificationHistory (low-stock / minimum dispatch rows) " +
      "plus digest emails — plumbing, not audited business state",
  },
  {
    path: "app/api/cron/stock-sync/route.ts",
    kind: "EXEMPT",
    reason:
      "machine trigger (codex #13): external stock pushes + Integration telemetry fields " +
      "(lastStockSyncAt / error / counters) — plumbing, not audited business state",
  },
  {
    path: "app/api/cron/weekly-report/route.ts",
    kind: "EXEMPT",
    reason: "machine trigger; sends the weekly digest email — no persistent business mutation",
  },
  {
    path: "app/api/cron/analytics-rebuild/route.ts",
    kind: "EXEMPT",
    reason:
      "machine trigger; rebuilds analytics fact tables — run telemetry via " +
      "analytics_rebuild_state / analytics_rebuild_runs, not audit events",
  },
  // --- the 4 DATA_EXPORT GETs (recordChange-required) ---
  {
    path: "app/api/inventory/export/route.ts",
    kind: "RECORDS_REQUIRED",
    reason: "recordChange-required (DATA_EXPORT); enforced by change-tracking-admin-config.test.ts",
  },
  {
    path: "app/api/admin/logs/export/route.ts",
    kind: "RECORDS_REQUIRED",
    reason: "recordChange-required (DATA_EXPORT); enforced by change-tracking-admin-config.test.ts",
  },
  {
    path: "app/api/admin/inventory/mass-update/export/route.ts",
    kind: "RECORDS_REQUIRED",
    reason: "recordChange-required (DATA_EXPORT); enforced by change-tracking-admin-config.test.ts",
  },
  {
    path: "app/api/admin/audit-logs/export/route.ts",
    kind: "RECORDS_REQUIRED",
    reason:
      "recordChange-required (DATA_EXPORT); the 4th export GET, previously omitted from the " +
      "D12 comment — recording characterized alongside the other DATA_EXPORT routes",
  },
  {
    path: "app/api/reports/reorder-recommendations/export/route.ts",
    kind: "RECORDS_REQUIRED",
    reason:
      "recordChange-required (DATA_EXPORT); the reorder report CSV export (Lane reorder-points) " +
      "records a DATA_EXPORT before streaming — enforced by reorder-export-route.test.ts",
  },
];

// Broadened side-effect lib families (rev-2). A GET-segment reference to a binding imported
// from one of these — or a direct recordChange/recordIngestion call — is a side-effect signal.
const SIDE_EFFECT_MODULE = /^@\/lib\/(email|stock-checker|external-orders\/stock-sync|analytics\/rebuild-)/;

/** Identifiers imported (named or default) from a broadened side-effect module. */
function sideEffectBindings(source: string): string[] {
  const ids: string[] = [];
  const importRe = /import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    if (!SIDE_EFFECT_MODULE.test(m[2])) continue;
    const clause = m[1].trim();
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const id = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (id) ids.push(id);
      }
    }
    const withoutNamed = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    const defaultId = withoutNamed.split(/\s+/)[0];
    if (defaultId && /^[A-Za-z_$][\w$]*$/.test(defaultId)) ids.push(defaultId);
  }
  return ids;
}

// True if the file's GET handler segment carries a WRITE-shaped side-effect signal.
// Write-shaped = a recordChange/recordIngestion call, a direct call of a function binding
// imported from a side-effect family (syncStockToExternal(), rebuildStockSnapshots()...), or
// a `.run` / `.send` dispatch method on such a binding (stockChecker.runDailyCheck(),
// emailService.sendEmail()). READ-shaped accessors (stockChecker.checkMinimums(),
// emailService.generateWeeklyReportHTML()) are intentionally NOT side effects — reports/
// minimums and stocker/minimums are read-only stockChecker consumers, so the registry stays
// at the eight genuinely-writing GETs (rev-2). Limit: a write method named outside the
// run/send/direct-call shape would be missed — documented; add such a route to the registry.
function getHandlerHasSideEffect(source: string): boolean {
  const seg = handlerSegments(source).get("GET");
  if (!seg) return false;
  if (/\b(recordChange|recordIngestion)\s*\(/.test(seg)) return true;
  for (const id of sideEffectBindings(source)) {
    const directCall = new RegExp(`\\b${id}\\s*\\(`);
    const writeMethod = new RegExp(`\\b${id}\\.(send|run)\\w*\\s*\\(`);
    if (directCall.test(seg) || writeMethod.test(seg)) return true;
  }
  return false;
}

describe("GET side-effect registry gate (Lane 5 I7 / codex #13)", () => {
  it("seeds all nine current side-effecting GET routes", () => {
    expect(GET_SIDE_EFFECT_REGISTRY.length).toBe(9);
    const exempt = GET_SIDE_EFFECT_REGISTRY.filter((e) => e.kind === "EXEMPT");
    const records = GET_SIDE_EFFECT_REGISTRY.filter((e) => e.kind === "RECORDS_REQUIRED");
    expect(exempt.length).toBe(4);
    // 4 admin/inventory DATA_EXPORT GETs + the reorder report CSV export (Lane reorder-points).
    expect(records.length).toBe(5);
  });

  it("every registered GET route file exists and carries a non-empty reason", () => {
    const seen = new Set<string>();
    for (const e of GET_SIDE_EFFECT_REGISTRY) {
      expect(seen.has(e.path)).toBe(false); // no duplicates
      seen.add(e.path);
      expect(fs.existsSync(path.join(REPO_ROOT, e.path))).toBe(true);
      expect(e.reason.trim().length).toBeGreaterThan(0);
      // Every registered entry must actually export a GET handler (stale registry guard).
      const source = fs.readFileSync(path.join(REPO_ROOT, e.path), "utf8");
      expect(handlerSegments(source).has("GET")).toBe(true);
    }
  });

  it("no unregistered GET route has a side effect in its GET handler (guards future GETs)", () => {
    const registered = new Set(GET_SIDE_EFFECT_REGISTRY.map((e) => e.path));
    const unregistered: string[] = [];
    for (const abs of discoverRouteFiles(API_DIR)) {
      const source = fs.readFileSync(abs, "utf8");
      if (!handlerSegments(source).has("GET")) continue; // only GET routes are candidates
      if (!getHandlerHasSideEffect(source)) continue;
      const repoPath = toRepoPath(abs);
      if (!registered.has(repoPath)) unregistered.push(`  ${repoPath}`);
    }
    expect(
      unregistered.length === 0
        ? ""
        : `GET routes whose GET handler has a side effect but are NOT in GET_SIDE_EFFECT_REGISTRY —\n` +
            `classify each (EXEMPT-with-reason or RECORDS_REQUIRED) in change-tracking-coverage.test.ts,\n` +
            `or keep the side effect out of the GET handler:\n` +
            unregistered.join("\n")
    ).toBe("");
  });

  it("the sweep is not vacuous — it detects the seeded routes", () => {
    // Sanity: each registered route must itself trip the side-effect detector, otherwise the
    // sweep above could pass while silently detecting nothing.
    const undetected = GET_SIDE_EFFECT_REGISTRY.filter(
      (e) => !getHandlerHasSideEffect(fs.readFileSync(path.join(REPO_ROOT, e.path), "utf8"))
    ).map((e) => `  ${e.path}`);
    expect(
      undetected.length === 0
        ? ""
        : `Registered GET routes the side-effect detector no longer trips (detector rot):\n` +
            undetected.join("\n")
    ).toBe("");
  });
});
