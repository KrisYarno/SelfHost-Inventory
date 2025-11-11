import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

async function ensureAdmin() {
  const session = await getSession();
  if (!session || !session.user?.isAdmin) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  return null;
}

function getBackupDir() {
  // Prefer the mounted backup volume
  const dir = process.env.BACKUP_DIR || "/backup";
  return dir;
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

export async function GET(req: NextRequest) {
  const unauthorized = await ensureAdmin();
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(req.url);
  const list = searchParams.get("list");
  const file = searchParams.get("file");
  const dir = getBackupDir();

  try {
    if (list) {
      const entries = await fs.readdir(dir).catch(() => []);
      const files = (entries || [])
        .filter((f) => f.endsWith(".sql") || f.endsWith(".sql.gz"))
        .map((name) => ({ name, mtimeMs: 0 }));
      // Get mtimes
      for (const f of files) {
        try {
          const st = await fs.stat(path.join(dir, f.name));
          f.mtimeMs = st.mtimeMs;
        } catch {}
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return new Response(JSON.stringify({ files }), { headers: { "content-type": "application/json" } });
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
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "Failed" }), { status: 500 });
  }
}

export async function POST() {
  const unauthorized = await ensureAdmin();
  if (unauthorized) return unauthorized;

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

  try {
    const buildArgs = (withRoutinesEvents: boolean) => [
      '-h', conn.host,
      '-P', String(conn.port || 3306),
      '-u', conn.user,
      `-p${conn.password}`,
      '--single-transaction', '--quick', '--no-tablespaces',
      ...(withRoutinesEvents ? ['--routines', '--events'] : []),
      conn.database,
    ];

    const runDump = (args: string[]) => new Promise<{ code: number; out: Buffer; err: Buffer }>((resolve) => {
      const ps = spawn("mysqldump", args);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      ps.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      ps.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      ps.on("error", (e) => resolve({ code: 127, out: Buffer.concat(out), err: Buffer.from(String(e)) }));
      ps.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(out), err: Buffer.concat(err) }));
    });

    // Try with routines/events first, then fall back without them if it fails.
    let res = await runDump(buildArgs(true));
    if (res.code !== 0) {
      res = await runDump(buildArgs(false));
      if (res.code !== 0) {
        return new Response(JSON.stringify({ error: `mysqldump failed (code ${res.code})`, details: res.err.toString() }), { status: 500 });
      }
    }

    // Write to file under /backup for persistence
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(full, res.out);
    } catch {}

    // Return as download (Buffer -> fresh ArrayBuffer)
    const ab = new Uint8Array(res.out).buffer;
    return new Response(ab, {
      headers: {
        "content-type": "application/sql",
        "content-disposition": `attachment; filename=\"${filename}\"`,
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "Backup failed" }), { status: 500 });
  }
}
