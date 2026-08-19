/**
 * The on-demand backup (`/api/admin/backup`) shells out to `mysqldump` inside the
 * app image, whose client is Alpine's `mariadb-client` (MariaDB 11.x). MySQL 8.4
 * creates every user with `caching_sha2_password`, and the MariaDB client only
 * carries that auth plugin via the `mariadb-connector-c` package
 * (/usr/lib/mariadb/plugin/caching_sha2_password.so). Without it the dump exits 2
 * before authenticating and the admin GUI reports "mysqldump failed (code 2)" —
 * found live on 2026-08-19. This pins the package onto the SAME `apk add` line as
 * the client, so a future slimming of the runtime stage cannot silently reopen it.
 */
import fs from 'node:fs';
import path from 'node:path';

const DOCKERFILE = path.join(process.cwd(), 'Dockerfile');

describe('Dockerfile — the backup client carries the caching_sha2_password plugin', () => {
  // Backslash continuations are joined first, so a future multi-line `RUN apk add \\`
  // block is matched as the one logical line it is (a false red would otherwise
  // follow a harmless reformat).
  const src = fs.readFileSync(DOCKERFILE, 'utf8').replace(/\\\r?\n\s*/g, ' ');
  const apkLines = src
    .split('\n')
    .filter((l) => /^\s*RUN\s+apk\s+add\b/.test(l) && /mariadb-client/.test(l));

  it('installs mariadb-client in exactly one apk add line (the runtime stage)', () => {
    expect(apkLines).toHaveLength(1);
  });

  it('installs mariadb-connector-c on that same line (the caching_sha2_password client plugin)', () => {
    expect(apkLines[0]).toMatch(/\bmariadb-connector-c\b/);
  });
});
