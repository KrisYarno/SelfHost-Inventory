/**
 * launch-gate/spawn.ts — harness lifecycle (spec C7 topology items 1/2/4; contract
 * pack T8; seam S11).
 *
 * Owns the four disposable resources this gate creates and destroys on EVERY run:
 * a throwaway `mysql:8.4` container, the app under test (`next dev` on 3100), the
 * MCP sidecar (3101) and the choreography shim (3102). Nothing here touches the dev
 * compose stack — the container carries a generated name, the processes bind
 * loopback test ports, and `stopAll()` removes all of it.
 *
 * FAILURE SAFETY (plan G2P-5): `stopAll()` is the ONE idempotent cleanup. A jest
 * globalSetup rejection SKIPS globalTeardown entirely, so setup calls it on any
 * failure before rethrowing; teardown calls it in a `finally`.
 *
 * PROCESS TREES: every child is spawned `detached`, making it a process-group
 * leader, and is killed as `-pgid` — `npx next dev` is two processes and a plain
 * `child.kill()` would orphan the inner one onto port 3100.
 */

import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  GATE_DB_PASSWORD,
  GATE_DB_USER,
  GATE_USERS,
  buildDatabaseUrl,
  containerIp,
  ensureWorkDir,
  gateDatabaseUrl,
  initialState,
  primeDatabaseUrl,
  readState,
  stateExists,
  updateState,
  workDirPath,
  workFile,
  writeState,
} from "./state";
import { GATE_SEED, seedGateDatabase } from "./seed";
import { captureChecksumBaseline, oracleQuery } from "./oracle";
import { apiDelete, apiGet, loginOnce, mcpCall, postTurn } from "./driver";
import { gatePrompt } from "./choreography";

export const REPO_ROOT = path.resolve(__dirname, "..");
export const APP_PORT = 3100;
export const MCP_PORT = 3101;
export const SHIM_PORT = 3102;
export const GATE_PORTS = [APP_PORT, MCP_PORT, SHIM_PORT] as const;

const MYSQL_IMAGE = "mysql:8.4";
const CONTAINER_PREFIX = "launch-gate-";
const DIST_GATE_PATH = path.join(REPO_ROOT, "mcp", "dist-gate");

/** Test-only literals. Never read from `.env` — the harness must not inherit the
 *  developer's deployment identity, and the app is disposable. */
const NEXTAUTH_SECRET = "launch-gate-test-nextauth-secret";
const ENCRYPTION_KEY = "bGF1bmNoLWdhdGUtdGVzdC1lbmNyeXB0aW9uLWtleSE=";

type ProcessName = "app" | "mcp" | "shim";

function log(message: string): void {
  console.log(`[launch-gate] ${message}`);
}

/** Phase timing, printed as the harness boots: run 1 vs run 2 symmetry is a stated
 *  exit criterion, and "which phase got slower" is the first question either way. */
async function phase<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  const result = await fn();
  log(`${name} — ${Date.now() - started}ms`);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------
// Preflight
// --------------------------------------------------------------------------

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (used: boolean): void => {
      socket.destroy();
      resolve(used);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

function portInUse(port: number): Promise<boolean> {
  return tcpOpen("127.0.0.1", port);
}

/** Fail CLOSED with an actionable message when the environment is not there (spec
 *  C7: "`launch` FAILS CLOSED with an actionable message"). */
export async function preflight(): Promise<void> {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "the launch gate needs a working Docker daemon (it boots a throwaway mysql:8.4 " +
        "container). Start Docker and re-run `node scripts/test-runner.js launch`.",
    );
  }
  const busy: number[] = [];
  for (const port of GATE_PORTS) {
    if (await portInUse(port)) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(
      `the launch gate needs ports ${GATE_PORTS.join("/")} free (app/mcp/shim) but ` +
        `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} already bound. Stop whatever ` +
        "holds them (a previous run that was killed mid-flight leaves nothing behind — check " +
        "for an unrelated dev server) and re-run.",
    );
  }
}

// --------------------------------------------------------------------------
// Database
// --------------------------------------------------------------------------

function containerName(): string {
  return `${CONTAINER_PREFIX}${process.pid}`;
}

async function waitForMysql(name: string, ip: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", name, "mysqladmin", "ping", `-u${GATE_DB_USER}`, `-p${GATE_DB_PASSWORD}`, "--silent"],
        { stdio: "pipe" },
      );
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`${name} never answered mysqladmin ping`);
      await sleep(1_000);
    }
  }
  // The entrypoint answers on the unix socket during its skip-networking init phase,
  // BEFORE TCP is up — wait for the real networked server or migrate deploy races
  // into a P1001 (scripts/verify-fresh-bootstrap.sh:12-15).
  for (;;) {
    if (await tcpOpen(ip, 3306)) return;
    if (Date.now() > deadline) throw new Error(`${name} never accepted TCP on ${ip}:3306`);
    await sleep(500);
  }
}

/** Container -> migrate deploy -> seed. Writes the state file as soon as the
 *  container exists so cleanup can find it even if the next step throws. */
export async function bootGateDatabase(): Promise<string> {
  ensureWorkDir();
  const name = containerName();
  log(`starting throwaway ${MYSQL_IMAGE} container ${name}`);
  const ip = await phase("container boot", async () => {
    execFileSync(
      "docker",
      [
        "run", "-d", "--name", name,
        "-e", `MYSQL_ROOT_PASSWORD=${GATE_DB_PASSWORD}`,
        "-e", "MYSQL_DATABASE=launch_gate",
        MYSQL_IMAGE,
      ],
      { stdio: "pipe" },
    );
    writeState(initialState(name));
    const address = containerIp(name);
    await waitForMysql(name, address);
    return address;
  });

  const databaseUrl = buildDatabaseUrl(ip);
  primeDatabaseUrl(databaseUrl);

  await phase("prisma migrate deploy", () => {
    execFileSync(path.join(REPO_ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  });

  await phase("seed", () => seedGateDatabase(databaseUrl));
  return databaseUrl;
}

// --------------------------------------------------------------------------
// Builds
// --------------------------------------------------------------------------

/**
 * ONE absolute `distGatePath` used everywhere (spec C7 item 4 / G2C-10): the tsup
 * config reads `MCP_OUT_DIR` verbatim, so a relative value resolves against the
 * `cwd: mcp` and can nest. The emit stays inside the repo so the ESM bundle sits
 * beside `mcp/package.json` (`type: module`) and node_modules.
 */
function buildMcpBundle(): string {
  log("building the MCP sidecar bundle (tsup)");
  execFileSync("npx", ["--no-install", "tsup"], {
    cwd: path.join(REPO_ROOT, "mcp"),
    env: { ...process.env, MCP_OUT_DIR: DIST_GATE_PATH },
    stdio: "pipe",
  });
  const entry = path.join(DIST_GATE_PATH, "server.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `tsup did not emit ${entry}. Inspect ${DIST_GATE_PATH} — the MCP spawn path must match ` +
        "tsup's real output layout.",
    );
  }
  return entry;
}

/** The shim is a real child process (own pid + process group, killable as a group),
 *  so it is bundled to CJS the same way the sidecar is. `mcp/src/server.ts:227`'s
 *  entry-guard pattern keeps importing the module from a test side-effect-free. */
function buildShimBundle(): string {
  log("building the choreography shim bundle (tsup)");
  const outDir = path.join(workDirPath(), "shim");
  execFileSync(
    "npx",
    [
      "--no-install", "tsup", path.join(REPO_ROOT, "launch-gate", "shim.ts"),
      "--out-dir", outDir,
      "--format", "cjs",
      "--platform", "node",
      "--target", "node22",
      "--silent",
    ],
    { cwd: REPO_ROOT, stdio: "pipe" },
  );
  // `.js`, not `.cjs`: the ROOT package.json has no `"type": "module"`, so tsup's
  // cjs format keeps the default extension (verified against tsup 8.5.1).
  const entry = path.join(outDir, "shim.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `tsup did not emit ${entry} for the choreography shim (found: ${fs.existsSync(outDir) ? fs.readdirSync(outDir).join(", ") : "nothing"})`,
    );
  }
  return entry;
}

// --------------------------------------------------------------------------
// Processes
// --------------------------------------------------------------------------

/**
 * The floor every child env is built on. Deliberately NOT `...process.env`: the
 * harness must not hand the developer's shell (or the runner's NODE_ENV=test) to the
 * app under test. `NODE_ENV` is pinned to development here and restated at each call
 * site — `next` PRESERVES an inherited value, so this is the load-bearing one.
 */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    FORCE_COLOR: "0",
    NODE_ENV: "development",
  };
}

function record(name: ProcessName, child: ChildProcess): void {
  const pid = child.pid ?? 0;
  if (pid === 0) throw new Error(`${name} failed to spawn`);
  updateState((state) => {
    // `detached` makes the child its own process-group leader, so pgid === pid.
    state.processes[name] = { pid, pgid: pid };
  });
}

function spawnLogged(
  name: ProcessName,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  const logPath = workFile(`${name}.log`);
  const stream = fs.openSync(logPath, "a");
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", stream, stream],
  };
  const child = spawn(command, args, spawnOptions);
  child.unref();
  record(name, child);
  return child;
}

function tail(name: ProcessName, lines = 40): string {
  try {
    return fs.readFileSync(workFile(`${name}.log`), "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log captured)";
  }
}

async function waitForHttp(
  name: ProcessName,
  url: string,
  timeoutMs: number,
  accept: (status: number) => boolean = (status) => status === 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  for (;;) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (accept(response.status)) return;
      lastError = `status ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown";
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${name} was not ready at ${url} within ${timeoutMs}ms (${lastError}).\n--- ${name} log ---\n${tail(name)}`,
      );
    }
    await sleep(500);
  }
}

function spawnApp(databaseUrl: string): void {
  spawnLogged("app", "npx", ["--no-install", "next", "dev", "-p", String(APP_PORT), "-H", "127.0.0.1"], {
    cwd: REPO_ROOT,
    env: {
      ...baseEnv(),
      // EXPLICIT (spec C7 item 2): `next` PRESERVES an inherited NODE_ENV, and the
      // runner exports NODE_ENV=test — unpinned, the dev server would run under test
      // env. Everything else is pinned so no `.env*` file on the machine can steer
      // the app under test at a real database or a real identity.
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      NEXTAUTH_URL: `http://localhost:${APP_PORT}`,
      NEXTAUTH_SECRET,
      ENCRYPTION_KEY,
      // "unset" in effect: an empty value is falsy at lib/auth.ts:10 (so the DEFAULT
      // allowed domain applies, which is where the seed emails live) AND it stops
      // @next/env from layering the repo's own .env value on top.
      ALLOWED_EMAIL_DOMAINS: "",
    },
  });
}

function spawnMcp(entry: string, databaseUrl: string): void {
  spawnLogged("mcp", process.execPath, [entry], {
    cwd: path.join(REPO_ROOT, "mcp"),
    env: {
      ...baseEnv(),
      // The sidecar's bootstrap no-ops under NODE_ENV=test (mcp/src/server.ts:227).
      NODE_ENV: "development",
      ENABLE_MCP: "1",
      MCP_PORT: String(MCP_PORT),
      DATABASE_URL: databaseUrl,
      ENCRYPTION_KEY,
    },
  });
}

function spawnShim(entry: string): void {
  spawnLogged("shim", process.execPath, [entry], {
    cwd: REPO_ROOT,
    env: {
      ...baseEnv(),
      NODE_ENV: "development",
      LAUNCH_GATE_SHIM_MAIN: "1",
      LAUNCH_GATE_SHIM_PORT: String(SHIM_PORT),
      LAUNCH_GATE_CHOREOGRAPHY_DIR: path.join(REPO_ROOT, "launch-gate", "choreography"),
    },
  });
}

/** Build + spawn shim, MCP and app, then poll each to readiness. */
export async function startProcesses(): Promise<void> {
  const databaseUrl = gateDatabaseUrl();
  const shimEntry = await phase("shim bundle", () => buildShimBundle());
  const mcpEntry = await phase("mcp bundle", () => buildMcpBundle());

  spawnShim(shimEntry);
  spawnMcp(mcpEntry, databaseUrl);
  spawnApp(databaseUrl);

  // The shim only serves POST /api/chat; a GET is a legitimate 404 from a LISTENING
  // server, which is exactly the readiness signal we want.
  await phase("shim ready", () =>
    waitForHttp("shim", `http://127.0.0.1:${SHIM_PORT}/api/chat`, 15_000, (status) => status === 404),
  );
  await phase("mcp ready", () => waitForHttp("mcp", `http://127.0.0.1:${MCP_PORT}/healthz`, 30_000));
  // `next dev` compiles the first route on demand; this poll IS that compile.
  log("waiting for next dev to compile its first route (this is the slow one)");
  await phase("app ready", () => waitForHttp("app", `http://127.0.0.1:${APP_PORT}/api/csrf`, 240_000));
}

// --------------------------------------------------------------------------
// Warm-up (OC-16)
// --------------------------------------------------------------------------

/**
 * One throwaway pass over every route the matrices assert against, BEFORE any
 * assertion: `next dev` compiles per route on first request, and an uncompiled route
 * would otherwise put run 1 and run 2 on different clocks. Every id this generates is
 * recorded in `warmupIds` and is excluded from matrix assertions.
 */
export async function warmUp(): Promise<void> {
  log("warm-up: logging in the seeded actors");
  await phase("warm-up logins", async () => {
    for (const user of GATE_USERS) await loginOnce(user);
  });

  const session = await loginOnce("memberA");
  log("warm-up: one scripted chat turn (compiles /api/assistant + the tool layer)");
  const turn = await phase("warm-up chat turn", () =>
    postTurn(session, {
      threadId: null,
      message: {
        id: "gate-warmup-user-message",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("infra-trivial-turn") }],
      },
      trigger: "submit-message",
    }),
  );
  if (turn.status !== 200 || turn.threadId === null) {
    throw new Error(
      `warm-up turn failed (status ${turn.status}). Body/stream:\n${turn.raw.slice(0, 2_000)}\n` +
        `--- app log ---\n${tail("app")}`,
    );
  }

  const threadId = turn.threadId;
  const requestRows = await oracleQuery<{ id: number }>(
    "SELECT id FROM assistant_requests WHERE threadId = ?",
    [threadId],
  );
  const requestIds = requestRows.map((row) => Number(row.id));
  const runRows =
    requestIds.length === 0
      ? []
      : await oracleQuery<{ id: number }>(
          `SELECT id FROM assistant_runs WHERE requestId IN (${requestIds.map(() => "?").join(",")})`,
          requestIds,
        );

  log("warm-up: thread list / detail / delete");
  const deleted = await phase("warm-up thread routes", async () => {
    await apiGet(session, "/api/assistant/threads");
    await apiGet(session, `/api/assistant/threads/${threadId}`);
    return apiDelete(session, `/api/assistant/threads/${threadId}`);
  });
  if (deleted.status !== 200 && deleted.status !== 204) {
    throw new Error(`warm-up thread DELETE returned ${deleted.status}: ${deleted.raw.slice(0, 500)}`);
  }

  log("warm-up: one MCP tool call");
  const mcp = await phase("warm-up mcp call", () =>
    mcpCall(GATE_SEED.apiTokens.memberA.plaintext, "tools/call", {
      name: "get_inventory_summary",
      arguments: {},
    }),
  );
  if (mcp.status !== 200) {
    throw new Error(`warm-up MCP call returned ${mcp.status}: ${mcp.raw.slice(0, 500)}`);
  }

  updateState((state) => {
    state.warmupIds = {
      threadIds: [threadId],
      requestIds,
      runIds: runRows.map((row) => Number(row.id)),
    };
  });
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

/** container -> migrate -> seed -> D8 baseline -> processes -> warm-up (pack T8). */
export async function startAll(): Promise<void> {
  await preflight();
  await bootGateDatabase();
  await phase("D8 checksum baseline", () => captureChecksumBaseline());
  await startProcesses();
  await phase("warm-up (total)", () => warmUp());
}

function killGroup(name: ProcessName): void {
  if (!stateExists()) return;
  const entry = readState().processes[name];
  if (entry === undefined || entry.pgid === 0) return;
  try {
    process.kill(-entry.pgid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Restart ONLY the app (OC-9). Used at phase boundaries to reset the route's
 * in-process rate limiter. JWT session cookies survive it — same NEXTAUTH_SECRET,
 * no server-side session store — so nobody re-logs in and the 20/15min per-IP
 * credentials limiter is untouched.
 */
export async function restartApp(): Promise<void> {
  log("restarting the app (new generation; sessions are reused)");
  killGroup("app");
  await sleep(500);
  spawnApp(gateDatabaseUrl());
  await waitForHttp("app", `http://127.0.0.1:${APP_PORT}/api/csrf`, 240_000);
  updateState((state) => {
    state.appGeneration += 1;
    state.postCounts[String(state.appGeneration)] = {} as Record<
      (typeof GATE_USERS)[number],
      number
    >;
    // BOTH limiters are in-process Maps in the app that just died (lib/rateLimit:18),
    // so the middleware's 30-per-60s /api/assistant bucket is empty again too (Task
    // 1.8, declared). Keeping stale timestamps would make the driver wait out a window
    // that no longer exists.
    state.postTimestamps = [];
  });
}

/**
 * THE idempotent cleanup, called by BOTH hooks. Never throws: a cleanup that fails
 * loudly on its second invocation is worse than one that finishes quietly.
 */
export async function stopAll(): Promise<void> {
  for (const name of ["app", "mcp", "shim"] as const) killGroup(name);
  await sleep(250);

  if (stateExists()) {
    const name = readState().containerName;
    if (name !== "" && process.env.LAUNCH_GATE_KEEP_DB !== "1") {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
      } catch {
        /* never started, or already removed */
      }
    } else if (name !== "") {
      log(`LAUNCH_GATE_KEEP_DB=1 — leaving container ${name} up for debugging`);
    }
  }

  for (const target of [workDirPath(), DIST_GATE_PATH]) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export type OrphanReport = { containers: string[]; boundPorts: number[] };

/** Post-cleanup evidence for the teardown assertion (seam S11). */
export async function findOrphans(): Promise<OrphanReport> {
  let containers: string[] = [];
  try {
    containers = execFileSync(
      "docker",
      ["ps", "-a", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{.Names}}"],
      { encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    containers = [];
  }
  const boundPorts: number[] = [];
  for (const port of GATE_PORTS) {
    if (await portInUse(port)) boundPorts.push(port);
  }
  return { containers, boundPorts };
}

export const GATE_CONTAINER_PREFIX = CONTAINER_PREFIX;
export const MCP_DIST_GATE_PATH = DIST_GATE_PATH;
