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
  getBatchLogs: jest.fn(async () => []),
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
      "read-only audit-log lookup; POST only carries batch filters in the body. " +
      "Imports @/lib/change-tracking for READ functions (getAuditLogs/getBatchLogs) " +
      "only — a read-only importer must never classify as RECORDS",
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
  { path: "app/api/account/default-location/route.ts", reason: "phase-B pending" },
  { path: "app/api/account/password/route.ts", reason: "phase-B pending" },
  { path: "app/api/account/username/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/backup/route.ts", reason: "phase-B pending (backup trigger; decide record-vs-exempt in Phase B)" },
  { path: "app/api/admin/companies/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/companies/[id]/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/integrations/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/integrations/[id]/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/integrations/[id]/price-sync/route.ts", reason: "phase-B pending (sync trigger; ingestion tier)" },
  { path: "app/api/admin/integrations/[id]/stock-sync/route.ts", reason: "phase-B pending (sync trigger; ingestion tier)" },
  { path: "app/api/admin/integrations/[id]/sync/route.ts", reason: "phase-B pending (sync trigger; ingestion tier)" },
  { path: "app/api/admin/locations/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/locations/[id]/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/product-mappings/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/products/[id]/restore/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/products/thresholds/route.ts", reason: "phase-B pending (R-D16 closure list)" },
  { path: "app/api/admin/settings/route.ts", reason: "phase-B pending" },
  { path: "app/api/admin/stock-check/route.ts", reason: "phase-B pending (manual stock-check trigger)" },
  { path: "app/api/auth/resend-notification/route.ts", reason: "phase-B pending" },
  { path: "app/api/auth/signup/route.ts", reason: "phase-B pending (USER_SIGNUP)" },
  { path: "app/api/orders/external/[orderId]/recheck/route.ts", reason: "phase-B pending (external orders; ingestion tier)" },
  { path: "app/api/products/bundle-links/route.ts", reason: "phase-B pending" },
  { path: "app/api/products/bundle-links/[linkId]/route.ts", reason: "phase-B pending" },
  { path: "app/api/products/[id]/links/route.ts", reason: "phase-B pending" },
  { path: "app/api/staging-items/[id]/route.ts", reason: "phase-B pending (R-D16 closure list)" },
  { path: "app/api/user/preferences/route.ts", reason: "phase-B pending" },
  { path: "app/api/webhooks/[integrationId]/route.ts", reason: "phase-B pending (webhook ingestion tier, R-D4)" },
];

/**
 * CARVE_OUTS — modules whose import genuinely resists the mock harness.
 * MUST stay empty unless a route module cannot be loaded even after adding
 * mocks; each entry needs a specific reason naming the stubborn import.
 * (R-D9 allows the list; the plan requires it to start EMPTY.)
 */
const CARVE_OUTS: Exemption[] = [];

// ---------------------------------------------------------------------------
// Discovery + classification
// ---------------------------------------------------------------------------

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
