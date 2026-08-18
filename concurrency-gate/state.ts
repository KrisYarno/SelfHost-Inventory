/**
 * concurrency-gate/state.ts — the cross-process harness state file (plan P-2;
 * contract pack C7a.1; seam S24).
 *
 * WHY A FILE: jest's `globalSetup` runs in the CLI process and its module state
 * never reaches a test suite's module registry. The one thing the scenarios need
 * to know about the booted harness — which throwaway container, at which URL —
 * therefore lives in a mode-0600 JSON file whose path `scripts/test-runner.js`
 * mints BEFORE jest starts and exports as `CONCURRENCY_GATE_STATE_FILE`.
 *
 * DELIBERATELY SMALLER THAN THE LAUNCH GATE'S: no profile, no process table, no
 * ports, no sessions, no checksum baseline. This gate boots a database and
 * nothing else — it drives the lib cores in-process over real Prisma clients.
 *
 * This module is the dependency LEAF: db/seed/clients/oracles all import it and
 * it imports none of them. Nothing under `launch-gate/` is imported at runtime
 * (pack C7a.1: importing its spawn.ts would drag the app, the MCP sidecar, the
 * choreography loader and the zero-business-writes checksum bracket in with it).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** The ONLY database name this harness will ever touch. The refusal belt below
 *  is what keeps a mis-built URL from pointing `migrate deploy`, the seed or a
 *  racer's client at the dev compose stack, the launch gate or any live schema. */
export const GATE_DB_NAME = "concurrency_gate";

export const GATE_DB_USER = "root";
export const GATE_DB_PASSWORD = "proof";

/** Every container this gate creates carries it, so a stray one is identifiable
 *  by name alone (`docker ps -a --filter name=concurrency-gate`). */
export const CONTAINER_PREFIX = "concurrency-gate-";

const STATE_ENV = "CONCURRENCY_GATE_STATE_FILE";

export type GateState = {
  containerName: string;
  /** The full container id `docker run -d` printed — the identity `docker rm`
   *  cannot be tricked out of by a name collision. */
  containerId: string;
  databaseUrl: string;
  /** The ANONYMOUS volumes the mysql image's `VOLUME /var/lib/mysql` created.
   *  Recorded the instant the container exists; teardown proves each one is gone. */
  volumeNames: string[];
};

/**
 * The state-file path the runner minted. Absent => the suite was started by hand
 * with a bare `jest`; say so instead of silently inventing a path. FAIL CLOSED:
 * an invented path would let two runs share (and corrupt) one document, and a
 * teardown that cannot find the container leaks it.
 */
export function stateFilePath(): string {
  const configured = process.env[STATE_ENV];
  if (!configured) {
    throw new Error(
      `${STATE_ENV} is not set. The concurrency gate must be started through ` +
        "`node scripts/test-runner.js concurrency` (or `npm run test:concurrency`), which " +
        "mints the per-run state file the harness and its scenarios share.",
    );
  }
  return configured;
}

export function initialState(containerName: string, containerId: string): GateState {
  return { containerName, containerId, databaseUrl: "", volumeNames: [] };
}

export function readState(): GateState {
  const raw = fs.readFileSync(stateFilePath(), "utf8");
  if (raw.trim() === "") {
    throw new Error(
      "The concurrency-gate state file is empty — global setup has not run (or failed before " +
        "it could write). Run the suite via `node scripts/test-runner.js concurrency`.",
    );
  }
  return JSON.parse(raw) as GateState;
}

/** True when the state file exists AND carries a parsed document. Used by
 *  teardown, which must work whether setup got as far as writing anything. */
export function stateExists(): boolean {
  try {
    return fs.existsSync(stateFilePath()) && fs.readFileSync(stateFilePath(), "utf8").trim() !== "";
  } catch {
    return false;
  }
}

/** Write via temp + rename: a rename is atomic, so a reader never sees a torn
 *  document. No lock file — global setup is this document's ONE writer. */
export function writeState(next: GateState): void {
  const target = stateFilePath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function patchState(patch: Partial<GateState>): GateState {
  const next = { ...readState(), ...patch };
  writeState(next);
  return next;
}

/** The refusal belt (pack C7a.1): anything whose database name is not
 *  `concurrency_gate` is rejected before a single statement runs. */
export function assertGateDatabaseUrl(url: string): void {
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("concurrency-gate refuses a DATABASE_URL it cannot parse");
  }
  if (database !== GATE_DB_NAME) {
    throw new Error(
      `concurrency-gate refuses to touch database "${database}" — the harness only ever ` +
        `operates on the throwaway "${GATE_DB_NAME}" container database.`,
    );
  }
}

export function buildDatabaseUrl(host: string): string {
  const url = `mysql://${GATE_DB_USER}:${GATE_DB_PASSWORD}@${host}:3306/${GATE_DB_NAME}`;
  assertGateDatabaseUrl(url);
  return url;
}

/** Container IP, the `scripts/verify-fresh-bootstrap.sh:11` shape (adapted from
 *  launch-gate/state.ts:250-260 — COPIED, never imported). The host reaches the
 *  container's bridge address directly: no published port, no host-port clash,
 *  nothing attached to a compose network. */
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

/** The gate URL a scenario's client connects with. Read from the state file
 *  every time (the value is written once, by setup) and refusal-checked again on
 *  the way out — the belt is worth more than the microsecond. */
export function gateDatabaseUrl(): string {
  const url = readState().databaseUrl;
  if (url === "") {
    throw new Error(
      "The concurrency-gate state file carries no databaseUrl — global setup did not finish.",
    );
  }
  assertGateDatabaseUrl(url);
  return url;
}
