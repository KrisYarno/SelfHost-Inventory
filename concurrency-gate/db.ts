/**
 * concurrency-gate/db.ts — the ONE disposable resource this gate creates and
 * destroys on every run: a throwaway `mysql:8.4` container (plan P-2; pack
 * C7a.1).
 *
 * Nothing here touches the dev compose stack or StagingProduction. The container
 * carries a generated `concurrency-gate-<pid>-<rand>` name, is attached to no
 * compose network, mounts no compose volume, and `stopDatabase()` removes it
 * WITH its anonymous volumes and then PROVES both are gone.
 *
 * THE LEAK GATE is name-and-volume specific on purpose (pack C7a.1): the exact
 * container id/name must no longer exist and every anonymous volume recorded at
 * boot must fail `docker volume inspect`. A global `docker volume ls` diff would
 * be flaky — unrelated Docker work on the machine moves that set.
 *
 * FAILURE SAFETY (G2P-5): a jest globalSetup rejection SKIPS globalTeardown
 * entirely, so setup calls `stopDatabase()` on any failure before rethrowing.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import {
  CONTAINER_PREFIX,
  GATE_DB_NAME,
  GATE_DB_PASSWORD,
  GATE_DB_USER,
  buildDatabaseUrl,
  containerIp,
  initialState,
  patchState,
  readState,
  stateExists,
  writeState,
} from "./state";

const MYSQL_IMAGE = "mysql:8.4";

export const REPO_ROOT = path.resolve(__dirname, "..");

function log(message: string): void {
  console.log(`[concurrency-gate] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Phase timing, printed as the harness boots — "which phase got slower" is the
 *  first question whenever a gate run stops feeling instant. */
async function phase<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  const result = await fn();
  log(`${name} — ${Date.now() - started}ms`);
  return result;
}

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

/** Fail CLOSED with an actionable message when the environment is not there
 *  (the launch gate's message shape). No ports are checked: this gate publishes
 *  none — the container is reached on its bridge address. */
function preflight(): void {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "the concurrency gate needs a working Docker daemon (it boots a throwaway mysql:8.4 " +
        "container). Start Docker and re-run `node scripts/test-runner.js concurrency`.",
    );
  }
}

function newContainerName(): string {
  return `${CONTAINER_PREFIX}${process.pid}-${randomBytes(3).toString("hex")}`;
}

/**
 * Two-stage readiness (COPIED/adapted from launch-gate/spawn.ts:136-159, never
 * imported): mysqladmin ping THEN a TCP probe. The rationale, verbatim: the
 * entrypoint answers on the unix socket during its skip-networking init phase,
 * BEFORE TCP is up — wait for the real networked server or migrate deploy races
 * into a P1001 (scripts/verify-fresh-bootstrap.sh:12-15).
 */
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
  for (;;) {
    if (await tcpOpen(ip, 3306)) return;
    if (Date.now() > deadline) throw new Error(`${name} never accepted TCP on ${ip}:3306`);
    await sleep(500);
  }
}

/** The anonymous volumes docker created for the image's `VOLUME /var/lib/mysql`.
 *  Bind mounts carry an empty `.Name` and are filtered out — this gate creates
 *  none, and a future one that did must not have it silently recorded as a
 *  volume to assert the removal of. */
function anonymousVolumes(nameOrId: string): string[] {
  const raw = execFileSync(
    "docker",
    ["inspect", "-f", '{{range .Mounts}}{{println .Name}}{{end}}', nameOrId],
    { encoding: "utf8" },
  );
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function containerExists(nameOrId: string): boolean {
  try {
    execFileSync("docker", ["inspect", "--type", "container", nameOrId], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function volumeExists(volumeName: string): boolean {
  try {
    execFileSync("docker", ["volume", "inspect", volumeName], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Container -> `prisma migrate deploy`. Returns the gate DATABASE_URL.
 *
 * ORDER IS CONTRACTUAL: the state file gains the container id/name and its
 * anonymous volume names the INSTANT `docker run` succeeds, so teardown can find
 * and prove the removal of everything even when the very next step throws.
 */
export async function bootDatabase(): Promise<string> {
  preflight();
  const name = newContainerName();
  log(`starting throwaway ${MYSQL_IMAGE} container ${name}`);

  const ip = await phase("container boot", async () => {
    // The IMAGE NAME PRECEDES the server args: everything before `mysql:8.4` is a
    // Docker CLI option, everything after is argv for mysqld inside the container.
    const containerId = execFileSync(
      "docker",
      [
        "run", "-d", "--name", name,
        "-e", `MYSQL_ROOT_PASSWORD=${GATE_DB_PASSWORD}`,
        "-e", `MYSQL_DATABASE=${GATE_DB_NAME}`,
        MYSQL_IMAGE,
        "--character-set-server=utf8mb4",
        "--collation-server=utf8mb4_unicode_ci",
      ],
      { encoding: "utf8" },
    ).trim();
    writeState(initialState(name, containerId));
    patchState({ volumeNames: anonymousVolumes(containerId) });

    const address = containerIp(name);
    await waitForMysql(name, address);
    return address;
  });

  const databaseUrl = buildDatabaseUrl(ip);
  patchState({ databaseUrl });

  await phase("prisma migrate deploy", () => {
    // ONLY the inline DATABASE_URL. The repo `.env` is never read: a gate that
    // inherits the developer's deployment identity is a gate that can migrate
    // the dev stack.
    execFileSync(path.join(REPO_ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  });

  return databaseUrl;
}

/**
 * Remove the container WITH its anonymous volumes, then prove it. Idempotent:
 * safe to call when nothing was ever created, and safe to call twice.
 *
 * The assertions are the PRIMARY leak gate. A teardown that only calls `docker
 * rm` and reports success is exactly the teardown that silently leaves a 200MB
 * volume behind on every run.
 */
export async function stopDatabase(): Promise<void> {
  if (!stateExists()) return;
  const state = readState();
  if (state.containerName === "") return;

  try {
    execFileSync("docker", ["rm", "-f", "-v", state.containerName], { stdio: "pipe" });
  } catch {
    /* never started, or already removed — the assertions below are the truth */
  }
  // `docker volume rm` of a just-detached anonymous volume can lose a race with
  // the daemon's own removal; give it a beat before asserting.
  await sleep(250);

  const failures: string[] = [];
  for (const identity of [state.containerName, state.containerId]) {
    if (identity !== "" && containerExists(identity)) {
      failures.push(`container ${identity} survived teardown`);
    }
  }
  for (const volume of state.volumeNames) {
    if (volumeExists(volume)) {
      failures.push(`anonymous volume ${volume} survived teardown`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`concurrency-gate teardown leaked resources:\n - ${failures.join("\n - ")}`);
  }
  log(
    `container ${state.containerName} removed; ${state.volumeNames.length} anonymous volume(s) ` +
      "verified gone",
  );
}
