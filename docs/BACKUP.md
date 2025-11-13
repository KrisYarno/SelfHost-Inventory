# Backup Guide

This project includes a `backup` service that performs nightly MySQL dumps into a persistent volume.

## Service Configuration

Compose definition (excerpt):
```
backup:
  image: fradelg/mysql-cron-backup
  environment:
    MYSQL_HOST: db
    MYSQL_USER: inventory
    MYSQL_PASS: ${MYSQL_PASSWORD}
    MYSQL_DB: inventory
    CRON_TIME: "0 3 * * *"
    MYSQLDUMP_OPTS: "--single-transaction --quick --routines --events --no-tablespaces"
    TZ: UTC
  volumes:
    - db_backups:/backup
```

Notes:
- The image uses MariaDB’s `mysqldump` syntax; avoid MySQL-only flags like `--set-gtid-purged`.
- `--no-tablespaces` prevents the need for PROCESS privilege.
- Backups are written to `/backup` in the container (mounted to `db_backups` volume).

## Manual Backup (Immediate)

Run a one-off dump and list files:
```bash
docker compose run --rm backup sh -lc 'mysqldump -h "$MYSQL_HOST" -u "$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" \
  --single-transaction --quick --routines --events --no-tablespaces \
  > /backup/manual-$(date +%F-%H%M%S).sql && ls -lh /backup'
```

## Admin GUI (List/Download)

- Open Admin → Backup.
- Use Refresh to list files in `/backup` (the shared volume).
- Download any listed backup.
- “Create Backup” attempts a dump from the app container. On some hosts, MySQL 8 auth can block the client in the app container. If a 500 occurs, use the manual one-off command above to create the dump, then download it via the GUI.

## Scheduled Backup (Cron)

The service starts `crond` in the foreground and runs at `CRON_TIME` (default 3AM UTC). To test scheduling quickly:
```bash
docker compose run --rm -e CRON_TIME='*/1 * * * *' backup
# wait ~60–90s, then check
docker compose run --rm backup sh -lc 'ls -lh /backup'
```

## Restore

To restore a dump into the compose DB:
```bash
docker compose exec -T db sh -lc 'mysql -uinventory -p"$MYSQL_PASSWORD" inventory' < path/to/backup.sql
```

## Troubleshooting

- `Access denied; PROCESS privilege required for tablespaces`:
  - Use `--no-tablespaces` in `MYSQLDUMP_OPTS` (already configured).

- `unknown variable 'set-gtid-purged=OFF'`:
  - Remove `--set-gtid-purged` — it’s not supported by this MariaDB mysqldump.

- No files appear when running `docker compose run --rm backup`:
  - That command starts `crond` and waits for the next `CRON_TIME` tick. Use the one-off mysqldump command above or temporarily set `CRON_TIME='*/1 * * * *'` for a minute‑by‑minute test.

- `mysqldump` from the app container fails but the backup service works:
  - The app image uses the MariaDB client on Alpine, which may not authenticate against MySQL 8’s default auth plugin. Prefer the service one-off command above, then download via the GUI.
