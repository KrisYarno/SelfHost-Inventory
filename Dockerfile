# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY . .
RUN npm run db:generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install curl for healthcheck and mariadb-client for on-demand backups
RUN apk add --no-cache curl mariadb-client

# Copy standalone build output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=3s --retries=5 CMD sh -lc "curl -sf http://127.0.0.1:${PORT:-3000}/api/healthz >/dev/null || exit 1"

CMD ["node", "server.js"]
