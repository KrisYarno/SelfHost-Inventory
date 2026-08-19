# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY . .
RUN npm run db:generate
RUN npm run build
# /api/version build-identity probe (2026-07-16 stale-image incident): bake the
# git sha + build time into the image. The GIT_SHA build arg wins; otherwise the
# sha is derived from the .git/HEAD+refs the .dockerignore negations let into
# the context. Placed AFTER `npm run build` so an arg change never busts the
# build layer cache.
ARG GIT_SHA=""
RUN sh scripts/build-info.sh "$GIT_SHA" > build-info.json

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Day bucketing (reports date-fns + analytics dayKey) assumes UTC; today that is
# only true by omission (no tzdata in alpine). Pin it so a base-image or host
# change can never silently shift report day boundaries.
ENV TZ=UTC

# Install curl for the healthcheck and the MariaDB client for on-demand backups
# (/api/admin/backup shells out to `mysqldump`). mariadb-connector-c is NOT optional:
# it ships /usr/lib/mariadb/plugin/caching_sha2_password.so, and MySQL 8.4 creates
# every user with caching_sha2_password — without the plugin the MariaDB mysqldump
# exits 2 ("Plugin caching_sha2_password could not be loaded") before it ever
# authenticates, and the admin GUI reports "mysqldump failed (code 2)".
RUN apk add --no-cache curl mariadb-client mariadb-connector-c

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/build-info.json ./build-info.json

# Ensure backup directory and .next/cache have correct ownership
RUN mkdir -p /backup .next/cache && chown -R nextjs:nodejs /backup .next/cache

EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=3s --retries=5 CMD sh -lc "curl -sf http://127.0.0.1:${PORT:-3000}/api/healthz >/dev/null || exit 1"

USER nextjs

CMD ["node", "server.js"]
