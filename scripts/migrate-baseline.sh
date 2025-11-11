#!/usr/bin/env bash
set -euo pipefail

# Generate a baseline SQL migration from an empty schema to the current Prisma datamodel.
# This lets you use `prisma migrate deploy` on fresh databases instead of `db push`.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

TS=$(date +%Y%m%d%H%M%S)
TARGET_DIR="prisma/migrations/${TS}_init_baseline"
mkdir -p "$TARGET_DIR"

echo "Generating baseline migration into: $TARGET_DIR/migration.sql"
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$TARGET_DIR/migration.sql"

echo "Baseline created. Review the SQL, then you can switch your deploy step to:\n  npx prisma migrate deploy && node scripts/seed-default-location.js"

