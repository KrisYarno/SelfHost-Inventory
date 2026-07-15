/**
 * __tests__/unit/lib/assistant/static-write-allowlist.ts — the NAMED allowlist for the
 * READ-ONLY GATE's STATIC source check (assistant toolsuite breadth, spec §7 layer 2).
 *
 * The static check (toolsuite-gates.test.ts) greps lib/assistant/tools.ts and the
 * read-path lib/reports / lib/analytics / lib/reorder-config modules it depends on for
 * Prisma write-method tokens. Any token it finds MUST have a matching entry here — a
 * legitimate shared-module write reachable only from web routes, NEVER from a tool's
 * `def.run`.
 *
 * TODAY: EMPTY. W0-4 closed R2-B1 (getGlobalReorderSettings() is findUnique + a defaults
 * constant; the admin PUT is the only authorized write path). The companion assertion
 * pins the length at <= 1 so the allowlist can only ever SHRINK — any new entry is a
 * deliberate, reviewed exception.
 *
 * (This module is also matched by jest's testMatch, so the shrink-only invariant lives
 * here as its own assertion rather than as a bare data file with no tests.)
 */

export interface StaticWriteAllowlistEntry {
  /** Repo-relative source file the write lives in. */
  file: string;
  /** The Prisma write-method token (create/update/upsert/…). */
  method: string;
  /** Why it is allowed, and when it goes away. */
  note: string;
}

export const STATIC_WRITE_ALLOWLIST: StaticWriteAllowlistEntry[] = [];

/** Baseline ceiling: the allowlist can only shrink from here. */
export const STATIC_WRITE_ALLOWLIST_MAX = 1;

describe("static write allowlist (spec §7 layer 2)", () => {
  it("only ever shrinks — length <= baseline", () => {
    expect(STATIC_WRITE_ALLOWLIST.length).toBeLessThanOrEqual(STATIC_WRITE_ALLOWLIST_MAX);
  });
});
