# Operations Runbook

This runbook covers daily operations, start/stop, logs, health, environment checks, database migrations, backups/restore, and common troubleshooting for the Inventory app.

## Quick Commands

- Start database only:
  - `docker compose up -d db`
- Apply schema + seed default location:
  - `docker compose up migrate`
- Start app + backup:
  - `docker compose up -d app backup`
- Stop app:
  - `docker compose stop app`
- Tail logs:
  - `docker compose logs -f app`
- Healthcheck:
  - `curl -I https://inventorylocal.artech.tools/api/healthz` → `200`

## Environment Checklist (production)

Ensure the following are set for the app container:

- `NEXTAUTH_URL=https://inventory.artech.tools`
- `NEXTAUTH_SECRET=<generated>`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `ALLOWED_EMAIL_DOMAINS=advancedresearchpep.com`
- `DATABASE_URL=mysql://inventory:${MYSQL_PASSWORD}@db:3306/inventory?connection_limit=20`

For local/dev behind Caddy, `NEXTAUTH_URL=https://inventorylocal.artech.tools`.

## Caddy Integration

The app joins the external `caddy` network with alias `inventory`. Example Caddyfile server block:

```
inventory.artech.tools {
  encode gzip zstd
  reverse_proxy inventory:3000 {
    header_up -x-middleware-subrequest
  }
}
```

Notes:
- Do not bind host ports in the app; Caddy terminates TLS.
- Keep `header_up -x-middleware-subrequest` to mitigate middleware-bypass class issues.

## Migrations Strategy

We use a baseline migration to transition from ad-hoc `db push` to `migrate deploy`.

- Fresh DBs (local/test):
  - `docker compose up -d db`
  - `docker compose up migrate` (runs `migrate deploy` or falls back to `db push`), seeds Location id=1
- Existing DBs (imported dumps):
  - Import dump first (see Restore), then `docker compose up migrate`.
  - If Prisma reports P3009 or history drift, resolve with:
    - `npx prisma migrate resolve --applied <baseline_id>` then rerun `npx prisma migrate deploy`.

Generate/update baseline (dev-only):
```
npm run migrate:baseline
# review SQL in prisma/migrations/<ts>_init_baseline
```

## Backups

Nightly backups run via the `backup` service into the `db_backups` volume.

- One-off backup (recommended for immediate dump):
  ```bash
  docker compose run --rm backup \
    sh -lc 'mysqldump -h "$MYSQL_HOST" -u"$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" \
      --single-transaction --quick --routines --events --no-tablespaces \
      > /backup/manual-$(date +%F-%H%M%S).sql && ls -lh /backup'
  ```
- GUI backup: Admin → Backup → Create Backup (may fail with client auth mismatch on MySQL 8; use the one-off above, then download via GUI).
- List backups:
  - `docker compose run --rm backup sh -lc 'ls -lh /backup'`

## Restore

- Import a dump into the compose DB:
  ```bash
  docker compose exec -T db sh -lc 'mysql -uinventory -p"$MYSQL_PASSWORD" inventory' < path/to/backup.sql
  ```
- If NULL prices were present in legacy data:
  ```sql
  UPDATE products SET retailPrice = 0 WHERE retailPrice IS NULL;
  UPDATE products SET costPrice = 0 WHERE costPrice IS NULL;
  ```
- Apply schema + seed:
  - `docker compose up migrate`

## User Admin

- Promote or create admin(s):
  ```bash
  docker compose run --rm migrate node scripts/promote-admin.js you@advancedresearchpep.com
  ```

## Smoke Tests

- Automated quick checks:
  - `BASE_URL=https://inventorylocal.artech.tools npm run smoke`
  - Accepts `401` or `307` on admin endpoints (redirect to `/auth/signin`).

## Troubleshooting

- 502/Bad Gateway via Caddy:
  - Ensure app is healthy and bound to `0.0.0.0:3000`.
  - Verify the container is on the `caddy` network with alias `inventory`.
  - Confirm the Caddy block includes `header_up -x-middleware-subrequest`.

- Prisma P3009 / migration drift:
  - Imported DB? Mark baseline as applied:
    - `npx prisma migrate resolve --applied <baseline_id>` then `npx prisma migrate deploy`.
  - As last resort locally: `npx prisma db push` (compose migrate already falls back automatically).

- CSP blocks sign-in or dev HMR:
  - Dev CSP allows inline/eval and Google OAuth endpoints.
  - Prod CSP allows Google OAuth and Next bootstrap scripts; adjust `next.config.mjs` if new domains needed.

- Rate limiting confusion:
  - There are two layers (middleware and per-route). Double limiting is expected for sensitive paths. Consolidate later if desired.

