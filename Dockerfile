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

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Day bucketing (reports date-fns + analytics dayKey) assumes UTC; today that is
# only true by omission (no tzdata in alpine). Pin it so a base-image or host
# change can never silently shift report day boundaries.
ENV TZ=UTC

# Install curl for healthcheck and mariadb-client for on-demand backups
RUN apk add --no-cache curl mariadb-client

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Ensure backup directory and .next/cache have correct ownership
RUN mkdir -p /backup .next/cache && chown -R nextjs:nodejs /backup .next/cache

EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=3s --retries=5 CMD sh -lc "curl -sf http://127.0.0.1:${PORT:-3000}/api/healthz >/dev/null || exit 1"

USER nextjs

CMD ["node", "server.js"]
