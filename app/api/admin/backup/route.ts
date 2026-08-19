import { NextRequest } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { enforceRateLimit } from "@/lib/rateLimit";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { listBackups, getBackupDir } from "@/lib/backup/list";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * The first line of mysqldump's stderr that actually explains a failure. The
 * MariaDB client prefixes every run with a deprecation notice and (when the
 * password rides MYSQL_PWD) a TLS-verification warning, neither of which is the
 * error — so they are skipped, and the real line (e.g. `Got error: 1045: ...`)
 * rides the `error` string the admin GUI alerts. The full stderr stays in
 * `details`. An exit code alone sent an operator to the container to find out
 * that the client was missing an auth plugin.
 */
function summarizeDumpError(stderr: Buffer): string | null {
  const noise = [/Deprecated program name/i, /--ssl-verify-server-cert is disabled/i];
  for (const raw of stderr.toString().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (noise.some((re) => re.test(line))) continue;
    // The program name is already in the message the GUI shows ("mysqldump failed ...").
    const bare = line.replace(/^(mysqldump|mariadb-dump):\s*/i, "");
    return bare.length > 300 ? `${bare.slice(0, 300)}…` : bare;
  }
  return null;
}

function parseDatabaseUrl(url: string) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

export const GET = apiHandler(async (req: NextRequest) => {
  await requireAdmin();

  const { searchParams } = new URL(req.url);
  const list = searchParams.get("list");
  const file = searchParams.get("file");
  const dir = getBackupDir();
  if (list) {
    // Shared reader: sorted newest-first with per-file mtimeMs; status distinguishes
    // an empty volume from an unreadable one (ops-health surfaces the latter).
    const listing = await listBackups();
    return new Response(JSON.stringify({ files: listing.files, status: listing.status }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (file) {
    const full = path.join(dir, path.basename(file));
    const data = await fs.readFile(full);
    const isGz = full.endsWith(".sql.gz");
    // Convert Node Buffer -> fresh ArrayBuffer (not SharedArrayBuffer)
    const ab = new Uint8Array(data).buffer;
    return new Response(ab, {
      headers: {
        "content-type": isGz ? "application/gzip" : "application/sql",
        "content-disposition": `attachment; filename="${path.basename(full)}"`,
      },
    });
  }

  return new Response(JSON.stringify({ error: "Bad request" }), { status: 400 });
});

export const POST = apiHandler(async (req: NextRequest) => {
  const { user } = await requireAdmin();

  // Tight limit: full-DB mysqldump spawns a shell process and is expensive.
  const rateLimitHeaders = enforceRateLimit(req, "admin-backup:POST", {
    identifier: user.id,
    limit: 3,
    ttl: 60 * 60 * 1000, // 1 hour
  });

  await requireCSRF(req);

  const dir = getBackupDir();
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const filename = `manual-${ts}.sql`;
  const full = path.join(dir, filename);

  const dbUrl = process.env.DATABASE_URL || "";
  const conn = parseDatabaseUrl(dbUrl);
  if (!conn) {
    return new Response(JSON.stringify({ error: "Invalid DATABASE_URL" }), { status: 500 });
  }

  // Ensure dir exists
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}

  const buildArgs = (withRoutinesEvents: boolean) => [
    "-h",
    conn.host,
    "-P",
    String(conn.port || 3306),
    "-u",
    conn.user,
    "--single-transaction",
    "--quick",
    "--no-tablespaces",
    ...(withRoutinesEvents ? ["--routines", "--events"] : []),
    conn.database,
  ];

  const runDump = (args: string[]) =>
    new Promise<{ code: number; out: Buffer; err: Buffer }>((resolve) => {
      const ps = spawn("mysqldump", args, {
        env: { ...process.env, MYSQL_PWD: conn.password },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      ps.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      ps.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      ps.on("error", (e) =>
        resolve({ code: 127, out: Buffer.concat(out), err: Buffer.from(String(e)) })
      );
      ps.on("close", (code) =>
        resolve({ code: code ?? 1, out: Buffer.concat(out), err: Buffer.concat(err) })
      );
    });

  // Try with routines/events first, then fall back without them if it fails.
  let res = await runDump(buildArgs(true));
  if (res.code !== 0) {
    res = await runDump(buildArgs(false));
    if (res.code !== 0) {
      const summary = summarizeDumpError(res.err);
      return new Response(
        JSON.stringify({
          error: `mysqldump failed (code ${res.code})${summary ? `: ${summary}` : ""}`,
          details: res.err.toString(),
        }),
        { status: 500 }
      );
    }
  }

  // Write to file under /backup for persistence
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(full, res.out);
  } catch {}

  // Record AFTER a successful dump, in its own tx. A record failure fails the
  // request (truthful): the admin retries and the on-disk file is timestamped,
  // not clobbered. sizeBytes comes from the dump already in memory.
  await prisma.$transaction(async (tx) => {
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "BACKUP_CREATED",
      entityType: "SYSTEM",
      entityId: null,
      action: `Created database backup ${filename}`,
      details: { filename, sizeBytes: Buffer.byteLength(res.out) },
    });
  });

  // Return as download (Buffer -> fresh ArrayBuffer)
  const ab = new Uint8Array(res.out).buffer;
  return new Response(ab, {
    headers: {
      ...rateLimitHeaders,
      "content-type": "application/sql",
      "content-disposition": `attachment; filename=\"${filename}\"`,
    },
  });
});
