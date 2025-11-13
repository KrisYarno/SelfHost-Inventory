# Smoke Test Checklist

Use this list after deploying or importing production data to ensure critical flows still work. Steps assume the compose stack is up (`docker compose up -d app`).

## Quick automated checks

```
npm run smoke
```

The script validates:

1. `/api/healthz` returns `200 {"status":"ok"}`.
2. `/auth/signin` loads (CSP/headers not blocking).
3. Anonymous requests to `/api/orders` and `/api/admin/dashboard` are rejected.
   - `/api/orders` returns 401.
   - `/api/admin/dashboard` returns 401 or 307 (redirect to `/auth/signin`). The smoke script accepts either.

## Manual UI walkthrough

1. **Login / Auth**
   - Browse to `https://inventorylocal.artech.tools` (through Caddy).
   - Click “Sign in with Google” and authenticate with an allowed domain account.
   - Verify pending-approval redirect for non-approved users (optional).

2. **Workbench flow**
   - Open Workbench, search for a product, add it to the cart, adjust quantities (+/-) and clear the order.
   - Confirm low-stock badges appear when quantity < threshold.

3. **Journal adjustments**
   - Navigate to Journal page.
   - Pick a product, add positive and negative adjustments, review changes, and submit.

4. **Inventory lists**
   - Check Inventory table (optimized view) for accurate quantities and price columns.
   - Drill into a product, confirm location totals match.

5. **Reports dashboard**
   - Open `/admin/reports`.
   - Ensure Total Products, Total Stock, Inventory Cost Value, Inventory Retail Value cards render without “NaN”.
   - Change date range; charts should refresh.

6. **Admin dashboard**
   - Visit `/admin` (admin account only).
   - Confirm active/pending user counts, low-stock tiles, and recent activity feed populate.

7. **Rate limits / Diagnostics**
   - Hit `/api/healthz` repeatedly (should stay 200).
   - Hit `/api/test/rate-limit` more than 3 times quickly (should return 429). Requires admin session.

8. **Backups**
   - Note: `docker compose run --rm backup` starts cron in the foreground and waits for the CRON_TIME schedule; it will sit until the next tick.
   - To verify immediately, use a one‑off mysqldump (single line):
     ```bash
     docker compose run --rm backup sh -lc 'mysqldump -h "$MYSQL_HOST" -u "$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" \
       --single-transaction --quick --routines --events --no-tablespaces \
       > /backup/manual-$(date +%F-%H%M%S).sql && ls -lh /backup'
     ```
     - Uses the `inventory` user from compose; `--no-tablespaces` avoids PROCESS privilege.
   - GUI: Admin → Backup → Refresh; Download the newest file. “Create Backup” attempts a dump from the app; if it fails, use the one‑off command above and then download.
   - Or, temporarily change schedule to every minute (for testing):
     ```bash
     docker compose run --rm -e CRON_TIME='*/1 * * * *' backup
     # wait ~60–90s, then list
     docker compose run --rm backup sh -lc 'ls -lh /backup'
     ```
   - Verify a new `.sql` or `.sql.gz` appears in `/backup` (db_backups volume).

9. **Logs + env sanity**
   - `docker compose logs --tail=50 app` → no unhandled errors.
   - `docker compose exec app sh -lc 'env | grep -E "NEXTAUTH_URL|ALLOWED_EMAIL_DOMAINS"'` → matches `.env`.

Document any failures before release; fix or file an issue.
