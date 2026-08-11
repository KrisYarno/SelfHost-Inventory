/**
 * launch-gate/state.ts — the cross-process harness state file (contract pack T8,
 * CP-7; seam S9).
 *
 * WHY A FILE: jest's `globalSetup` runs in the CLI process and its module state
 * never reaches a test suite's module registry. Everything the matrices need to
 * know about the booted harness — which container, which pids, which logged-in
 * sessions, how many POSTs each user has spent this app generation — therefore
 * lives in a mode-0600 JSON file whose path `scripts/test-runner.js` mints BEFORE
 * jest starts and exports as `LAUNCH_GATE_STATE_FILE`.
 *
 * Every mutation goes through `updateState`, which takes an exclusive lock file,
 * re-reads, applies, and renames a temp file into place. Reads are plain
 * `readFileSync` — a rename is atomic, so a reader never sees a torn document.
 *
 * This module is the harness's dependency LEAF: spawn/seed/driver/oracle all
 * import it and it imports none of them.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Session = {
  // Widened by Task 1.8 (declared): the seed gained a FOURTH actor (pack REV-9 F-3),
  // and `driver.loginOnce` indexes `GATE_SEED.actors` by exactly this union — so the
  // union and the seed manifest's actor keys are one contract in two files. state.ts
  // stays the dependency LEAF (no import of seed.ts, not even type-only).
  user: "memberA" | "zeroUser" | "admin" | "noFactsUser";
  cookieHeader: string;
  csrfToken: string;
};

export type HarnessState = {
  version: 1;
  appGeneration: number;
  processes: Record<"app" | "mcp" | "shim", { pid: number; pgid: number }>;
  containerName: string;
  sessions: Record<Session["user"], Session>;
  postCounts: Record<string, Record<Session["user"], number>>;
  /**
   * Epoch-ms of recent `POST /api/assistant` calls, ACROSS ALL CALLERS (Task 1.8,
   * declared). The route's own 30/hr per-USER limiter is what `postCounts` models;
   * `middleware.ts:43` additionally runs `enforceRateLimit(request,
   * "middleware:/api/assistant")` with lib/rateLimit's DEFAULTS — 30 requests per 60
   * SECONDS, keyed by IP, so every seeded caller shares ONE bucket. That is the
   * binding constraint for a matrix this size, and it is a wall-clock window rather
   * than a count, so it needs its own bookkeeping.
   */
  postTimestamps: number[];
  warmupIds: { threadIds: string[]; requestIds: number[]; runIds: number[] };
};

/** The ONLY database name this harness will ever touch. The refusal belt below is
 *  what keeps a mis-built URL from pointing the migrate/seed/oracle path at the dev
 *  compose stack or any other live schema (spec C7 topology item 1). */
export const GATE_DB_NAME = "launch_gate";

export const GATE_DB_USER = "root";
export const GATE_DB_PASSWORD = "proof";

/** Actor keys in a fixed order — the POST-budget bookkeeping and the session map
 *  both key off these. */
export const GATE_USERS: ReadonlyArray<Session["user"]> = [
  "memberA",
  "zeroUser",
  "admin",
  "noFactsUser",
];

const STATE_ENV = "LAUNCH_GATE_STATE_FILE";

/**
 * THE RUN PROFILE (plan Task 3.3; spec C7 topology item 2's "W3 close additionally
 * runs the FULL matrix once against `next build && next start`").
 *
 * `dev` — `next dev` under NODE_ENV=development, the path W1/W2 built.
 * `start` — ONE `next build` and then `next start`, under NODE_ENV=production: the
 * production artifact, which is what a deploy actually ships (standalone tracing,
 * prod bundling, per-route compilation differences).
 *
 * It lives HERE, in the dependency leaf, because both the harness (which spawns the
 * app) and the SUITES (whose expectations differ by profile — `NODE_ENV` is what the
 * report route derives its stored `environment` from) must read the same value
 * without importing spawn.ts's process-management graph.
 */
export type GateProfile = "dev" | "start";

export const GATE_PROFILE_ENV = "LAUNCH_GATE_PROFILE";

export function gateProfile(): GateProfile {
  const configured = process.env[GATE_PROFILE_ENV] ?? "dev";
  if (configured !== "dev" && configured !== "start") {
    throw new Error(
      `${GATE_PROFILE_ENV}="${configured}" is not a launch-gate profile. Use "dev" ` +
        '(next dev) or "start" (next build + next start), or leave it unset for "dev".',
    );
  }
  return configured;
}

/**
 * The `NODE_ENV` the app under test runs with, per profile. `next` PRESERVES an
 * inherited NODE_ENV (spec C7 item 2), so the harness pins it explicitly on both
 * paths and the suites read the SAME function rather than re-deriving the mapping.
 */
export function appNodeEnv(profile: GateProfile = gateProfile()): "development" | "production" {
  return profile === "start" ? "production" : "development";
}

/**
 * The state-file path the runner minted. Absent => the suite was started by hand
 * with a bare `jest`; say so instead of silently inventing a path (two runs sharing
 * an invented path would corrupt each other).
 */
export function stateFilePath(): string {
  const configured = process.env[STATE_ENV];
  if (!configured) {
    throw new Error(
      `${STATE_ENV} is not set. The launch gate must be started through ` +
        "`node scripts/test-runner.js launch` (or `npm run test:launch`), which mints the " +
        "per-run state file the harness and its suites share.",
    );
  }
  return configured;
}

/** Sidecar holding the D8 checksum BASELINE digests: globalSetup writes it after the
 *  seed, globalTeardown reads and unlinks it. Same lifetime as the state file. */
export function baselineFilePath(): string {
  return `${stateFilePath()}.baseline.json`;
}

/** Per-run scratch directory (process logs + the built shim bundle). Lives beside
 *  the state file so BOTH hooks derive the same path without sharing memory. */
export function workDirPath(): string {
  return `${stateFilePath()}.work`;
}

export function initialState(containerName: string): HarnessState {
  return {
    version: 1,
    appGeneration: 1,
    processes: {
      app: { pid: 0, pgid: 0 },
      mcp: { pid: 0, pgid: 0 },
      shim: { pid: 0, pgid: 0 },
    },
    containerName,
    sessions: {} as Record<Session["user"], Session>,
    postCounts: {},
    postTimestamps: [],
    warmupIds: { threadIds: [], requestIds: [], runIds: [] },
  };
}

export function readState(): HarnessState {
  const raw = fs.readFileSync(stateFilePath(), "utf8");
  if (raw.trim() === "") {
    throw new Error(
      "The launch-gate state file is empty — global setup has not run (or failed before " +
        "it could write). Run the suite via `node scripts/test-runner.js launch`.",
    );
  }
  return JSON.parse(raw) as HarnessState;
}

/** True when the state file exists AND carries a parsed document. Used by cleanup,
 *  which must work whether setup got as far as writing anything or not. */
export function stateExists(): boolean {
  try {
    return fs.existsSync(stateFilePath()) && fs.readFileSync(stateFilePath(), "utf8").trim() !== "";
  } catch {
    return false;
  }
}

export function writeState(next: HarnessState): void {
  const target = stateFilePath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Read-modify-write under an exclusive lock. `mutate` may return a value; the
 * updated state and that value come back together so a caller can (for example)
 * increment a counter and read the new total in one critical section.
 */
export function updateState<T>(mutate: (state: HarnessState) => T): { state: HarnessState; result: T } {
  const lock = `${stateFilePath()}.lock`;
  const deadline = Date.now() + 10_000;
  let handle: number | undefined;
  for (;;) {
    try {
      handle = fs.openSync(lock, "wx");
      break;
    } catch {
      if (Date.now() > deadline) {
        // A stale lock from a killed process must not wedge the run forever.
        try {
          fs.unlinkSync(lock);
        } catch {
          /* someone else won the race; retry */
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    const state = readState();
    const result = mutate(state);
    writeState(state);
    return { state, result };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** The refusal belt (spec C7 item 1): anything whose database name is not
 *  `launch_gate` is rejected before a single statement runs. */
export function assertGateDatabaseUrl(url: string): void {
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("launch-gate refuses a DATABASE_URL it cannot parse");
  }
  if (database !== GATE_DB_NAME) {
    throw new Error(
      `launch-gate refuses to touch database "${database}" — the harness only ever operates ` +
        `on the throwaway "${GATE_DB_NAME}" container database.`,
    );
  }
}

export function buildDatabaseUrl(host: string): string {
  const url = `mysql://${GATE_DB_USER}:${GATE_DB_PASSWORD}@${host}:3306/${GATE_DB_NAME}`;
  assertGateDatabaseUrl(url);
  return url;
}

/** Container IP, the `scripts/verify-fresh-bootstrap.sh:11` shape. The host reaches
 *  the container's bridge address directly — no published port, no host-port clash. */
export function containerIp(containerName: string): string {
  const ip = execFileSync(
    "docker",
    ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerName],
    { encoding: "utf8" },
  ).trim();
  if (ip === "") {
    throw new Error(`container ${containerName} has no IP address (is it running?)`);
  }
  return ip;
}

let cachedDatabaseUrl: string | null = null;

/**
 * The gate DATABASE_URL, resolved from the container recorded in the state file.
 * Cached per process: the container's address cannot change within a run, and the
 * oracle asks for this on every digest.
 */
export function gateDatabaseUrl(): string {
  if (cachedDatabaseUrl === null) {
    cachedDatabaseUrl = buildDatabaseUrl(containerIp(readState().containerName));
  }
  return cachedDatabaseUrl;
}

/** Only global setup should need this — it knows the URL before any state exists. */
export function primeDatabaseUrl(url: string): void {
  assertGateDatabaseUrl(url);
  cachedDatabaseUrl = url;
}

export function ensureWorkDir(): string {
  const dir = workDirPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function workFile(name: string): string {
  return path.join(workDirPath(), name);
}
