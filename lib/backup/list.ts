import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * lib/backup/list.ts — the shared backup-volume reader (Lane 3, spec §10 R-L14 /
 * §11 D-L4). Returns a discriminated result so callers can tell "no backups yet"
 * (status 'ok', empty files) from "volume unreadable" (status 'unavailable' with
 * the errno): the two are distinct labeled states on the ops-health card. Per-file
 * stat runs through Promise.allSettled so one unstat-able file never sinks the
 * whole listing.
 */

export interface BackupFile {
  name: string;
  mtimeMs: number;
}

export interface BackupListing {
  status: "ok" | "unavailable";
  errorCode?: string;
  files: BackupFile[];
}

/** The mounted backup volume (docker-compose mounts /backup); env-overridable. */
export function getBackupDir(): string {
  return process.env.BACKUP_DIR || "/backup";
}

export async function listBackups(): Promise<BackupListing> {
  const dir = getBackupDir();

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    // The volume itself is unreadable (ENOENT unmounted, EACCES, ...). This is
    // NOT "no backups" — surface it as a distinct unavailable state with the errno.
    const code = (err as NodeJS.ErrnoException)?.code ?? "READ_FAILED";
    return { status: "unavailable", errorCode: code, files: [] };
  }

  const names = entries.filter((f) => f.endsWith(".sql") || f.endsWith(".sql.gz"));

  const settled = await Promise.allSettled(
    names.map(async (name): Promise<BackupFile> => {
      const st = await fs.stat(path.join(dir, name));
      return { name, mtimeMs: st.mtimeMs };
    }),
  );

  const files = settled
    .filter((r): r is PromiseFulfilledResult<BackupFile> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return { status: "ok", files };
}
