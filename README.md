## Inventory App (Rebuild)

Modern inventory management built with Next.js (App Router), TypeScript, Prisma (MySQL), and Docker. This README reflects the current Rebuild state: auth, pricing, migrations, and Docker/Caddy deployment.

### Highlights
- Google OAuth (NextAuth v4), domain allowlist via `ALLOWED_EMAIL_DOMAINS`.
- Admin + approval model; pending-approval flow for new users.
- Product pricing (`costPrice`, `retailPrice`); reports include inventory cost and retail value.
- Optimistic locking for inventory updates; detailed audit trail.
- `/api/healthz` endpoint for container health.
- Docker Compose stack with DB, migrate, app, nightly backup.
- Caddy reverse proxy support via external Docker network.

## 📦 Getting Started

### Prerequisites
- Node.js 20+
- MySQL (or use Docker Compose)
- Google OAuth Client ID/Secret

### Installation

1. Clone the repository:
```bash
cd "inventory app rebuild"
```

2. Install dependencies:
```bash
npm install
```

3. Environment
Copy `.env.example` → `.env` and fill values:
```env
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<openssl rand -base64 32>
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>

# Optional for local DB; Compose sets its own DATABASE_URL for services
# DATABASE_URL=mysql://user:pass@localhost:3306/inventory

# Domain allowlist for Google OAuth
ALLOWED_EMAIL_DOMAINS=advancedresearchpep.com
```

4. Generate Prisma Client
```bash
npx prisma generate
```

5. Start the development server:
```bash
npm run dev
```

Open `http://localhost:3000`.

## 🏗️ Project Structure

```
inventory-app-rebuild/
├── app/                    # Next.js app directory
│   ├── (app)/             # Authenticated app routes
│   │   ├── workbench/     # Order fulfillment interface
│   │   ├── journal/       # Bulk adjustment interface
│   │   ├── products/      # Product management
│   │   ├── inventory/     # Inventory lists & logs
│   │   └── admin/
│   │       ├── reports/   # Analytics dashboard (moved under Admin)
│   │       └── backup/    # GUI for listing/downloading backups
│   ├── api/               # API routes
│   └── auth/              # Authentication pages
├── components/            # React components
├── contexts/              # React contexts (location)
├── hooks/                 # Custom React hooks
├── lib/                   # Utility functions
├── prisma/                # Database schema
├── public/                # Static assets
└── types/                 # TypeScript types
```

---

## Docker Compose

Services:
- `db` (MySQL 8.4)
- `migrate` (one-shot): `migrate deploy` OR fallback to `db push`, then seed default location
- `app` (Next standalone): binds `0.0.0.0:3000`, healthcheck via `/api/healthz`
- `backup`: nightly mysqldump to volume

Bring up:
```
docker compose up -d db
docker compose up migrate
docker compose up -d --build app backup
```

Health:
```
curl -I https://inventorylocal.artech.tools/api/healthz  # expect 200
```

### Caddy
App joins external `caddy` network with alias `inventory`. Example Caddyfile (include defense-in-depth header):
```
inventorylocal.artech.tools {
  encode gzip zstd
  reverse_proxy inventory:3000 {
    header_up -x-middleware-subrequest
  }
}

# Production domain
inventory.artech.tools {
  encode gzip zstd
  reverse_proxy inventory:3000 {
    header_up -x-middleware-subrequest
  }
}
```
Reload: `docker exec caddy_proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`

---

### Backups

The `backup` service runs nightly mysqldump to the `db_backups` volume. You can also trigger a manual dump and download it.

- Manual one‑off backup (service, immediate):
  ```bash
  docker compose run --rm backup sh -lc 'mysqldump -h "$MYSQL_HOST" -u "$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" \
    --single-transaction --quick --routines --events --no-tablespaces \
    > /backup/manual-$(date +%F-%H%M%S).sql && ls -lh /backup'
  ```
  - Uses the `inventory` DB user; `--no-tablespaces` avoids PROCESS privilege errors.
  - Note: `docker compose run --rm backup` (without a command) starts cron and waits; it will not exit.

- GUI (Admin → Backup):
  - “Create Backup” attempts a dump and prompts download; list shows files from `/backup`.
  - If a 500 occurs due to client/server auth mismatch, use the manual one‑off command above, then use the GUI to download the newest file.

- List backups:
  ```bash
  docker compose run --rm backup sh -lc 'ls -lh /backup'
  ```

- Test schedule quickly:
  ```bash
  docker compose run --rm -e CRON_TIME='*/1 * * * *' backup
  # wait ~60–90s, then list backups
  docker compose run --rm backup sh -lc 'ls -lh /backup'
  ```

- Restore example (from inside DB container):
  ```bash
  docker compose exec -T db sh -lc 'mysql -uinventory -p"$MYSQL_PASSWORD" inventory' < path/to/backup.sql
  ```

---

## Clone Production (Railway) → Local

1) Export (no CREATE DATABASE):
```
set -a; source .env.railway; set +a

mysqldump \
  -h "$RAILWAY_TCP_PROXY_DOMAIN" \
  -P "$RAILWAY_TCP_PROXY_PORT" \
  -u "$MYSQLUSER" \
  -p"$MYSQLPASSWORD" \
  --single-transaction --quick --routines --events \
  "$MYSQLDATABASE" \
  > railway-backup.sql
```

2) Stop app: `docker compose stop app`

3) Import into compose DB (`inventory`):
```
docker compose exec -T db sh -lc 'mysql -uinventory -p"$MYSQL_PASSWORD" inventory' < railway-backup.sql
```

4) Apply schema + seed:
```
docker compose up migrate
```

5) Start app: `docker compose up -d app`

If NULL prices block schema push, normalize:
```
UPDATE products SET retailPrice=0 WHERE retailPrice IS NULL;
UPDATE products SET costPrice=0 WHERE costPrice IS NULL;
```

Promote admin if needed:
```
docker compose run --rm migrate node scripts/promote-admin.js you@advancedresearchpep.com
```

---

## Auth & Security
- NextAuth v4 (Google provider only; credentials removed)
- Env: `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS`
- New accounts: not approved → pending page; approve via UI or promote script.
- CSP tuned per env; production allows Google OAuth and Next bootstrap scripts.
- `/api/healthz` used by Docker healthcheck.

## Reports & Pricing
- Products carry `costPrice`/`retailPrice`.
- Reports aggregate inventory by product/location and compute cost/retail totals.
- Reports UI lives at `/admin/reports` (moved under Admin). Use the Admin sub‑nav.

## Mobile Navigation
- Bottom nav includes Journal. Reports are accessible via Admin → Reports to conserve space on small screens.

## Troubleshooting
- 502 via Caddy: ensure app binds `0.0.0.0` and Caddy proxies `inventory:3000` on the `caddy` network.
- AccessDenied on sign-in: verify `ALLOWED_EMAIL_DOMAINS` and Google OAuth URIs (redirect + origin).
- FK error on first login: seed default Location id=1 (handled by migrate job).

## Scripts
- `npm run type-check`
- `npx prisma generate`
- `npm run migrate:baseline`
- `node scripts/seed-default-location.js`
- `node scripts/promote-admin.js you@advancedresearchpep.com`

## 🔐 Authentication & Authorization

The system uses NextAuth.js for authentication with:
- Google OAuth provider
- Email/password credentials
- Admin approval workflow for new users
- Role-based access control (User/Admin)

### User Roles
- **USER**: Can manage inventory, create orders, view reports
- **ADMIN**: All user permissions plus user management and product CRUD

## 📊 Key Workflows

### Workbench Mode (Order Fulfillment)
1. Select location from the location switcher
2. Search and filter products as needed
3. Click products to add to order
4. Choose quantities with quick picks
5. Enter order reference
6. Complete & deduct from inventory

### Journal Mode (Bulk Adjustments)
1. Select location from the location switcher
2. Search for products
3. Make inline adjustments with +/- controls
4. Review changes summary
5. Submit all changes at once

### Product Management (Admin Only)
- Create products with name, base name, variant structure
- Edit product details
- Soft delete (deactivate) products
- Bulk operations support

## 🛠️ Development

### Available Scripts
```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm run db:pull      # Pull schema from database
npm run db:generate  # Generate Prisma Client
npm run db:studio    # Open Prisma Studio
npm run env:check    # Validate environment variables
```

### Database Management
```bash
npx prisma studio     # Open Prisma Studio GUI
npx prisma db pull    # Pull schema from existing database
npx prisma generate   # Generate Prisma Client
```

## 📱 Mobile Support

The application is fully responsive with:
- Touch-optimized interfaces
- Mobile-first design approach
- Adaptive navigation (sidebar on desktop, bottom nav on mobile)
- Swipe gestures in Journal mode
- Large touch targets (44px minimum)

## 🎨 Theming

The app supports light and dark modes with:
- System preference detection
- Manual theme toggle
- Persistent preference storage
- Smooth transitions
- Consistent color tokens across all components

## 🔄 Multi-Location Support

- Switch between locations using the location switcher
- All inventory operations respect the selected location
- Location-specific inventory levels
- Location-based reporting

## 🚢 Deployment

The application is designed for deployment on:
- **Web**: Vercel, Render, or any Node.js hosting
- **Database**: MySQL-compatible services (Railway, PlanetScale, etc.)

Environment variables should be configured in your deployment platform.

## 📄 License

This project is proprietary software. All rights reserved.

## 🤝 Contributing

Please follow these guidelines:
1. Use TypeScript with strict mode
2. Follow the existing code style
3. Write meaningful commit messages
4. Test your changes thoroughly
5. Update documentation as needed

---

Built with Next.js, Prisma, Tailwind CSS, and shadcn/ui
