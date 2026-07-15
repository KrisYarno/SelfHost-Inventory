/**
 * Prisma stand-in for the alias-bundled MOCK builds (tsup with MCP_BUILD_MOCK=1,
 * and the `smoke` bundle). tsup aliases `@/lib/prisma` to this module so the built
 * sidecar / smoke bundle runs end-to-end WITHOUT a database. The PRODUCTION build
 * (default `tsup`) binds the REAL `@/lib/prisma` singleton — this mock is never in
 * the shipped image.
 *
 * Delegates cover exactly what the mock server graph touches:
 *   - apiToken.findUnique  — echoes the queried tokenHash back as the stored hash
 *     so the auth timing-safe compare passes; owner is approved/live/admin. This
 *     makes ANY well-shaped Bearer authenticate against the mock build (used by the
 *     built-artifact smoke test's HTTP round-trip).
 *   - apiToken.update      — best-effort lastUsedAt.
 *   - userCompany.findMany — resolveToolContext memberships (none).
 *   - assistantRun.create  — telemetry (best-effort).
 *   - product / product_locations / systemSetting — find_product's read graph.
 *   - $queryRaw            — the /healthz SELECT 1 probe.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const prismaMock: any = {
  apiToken: {
    findUnique: async ({ where }: { where: { tokenHash: string } }) => ({
      id: "tok_mock",
      tokenHash: where.tokenHash,
      revokedAt: null,
      ownerUserId: 1,
      owner: { isAdmin: true, isApproved: true, deletedAt: null },
    }),
    update: async () => ({ id: "tok_mock" }),
  },
  userCompany: {
    findMany: async () => [],
  },
  assistantRun: {
    create: async () => ({ id: 1 }),
  },
  product: {
    count: async () => 0,
    findMany: async () => [],
    findUnique: async () => null,
    findFirst: async () => null,
  },
  product_locations: {
    findMany: async () => [],
  },
  systemSetting: {
    findUnique: async () => null,
  },
  // Wave-1 breadth tools' read graphs (get_valuation / get_movement_series /
  // get_inventory_summary / get_inventory_policy / get_data_freshness) — benign shapes
  // so the mock build can serve them end-to-end without a database.
  inventory_logs: {
    findMany: async () => [],
    groupBy: async () => [],
    aggregate: async () => ({ _min: {}, _max: {}, _sum: {}, _count: {} }),
  },
  analyticsRebuildState: {
    findUnique: async () => null,
  },
  fulfillmentSyncState: {
    findMany: async () => [],
  },
  productStockSnapshot: {
    aggregate: async () => ({ _min: {} }),
    groupBy: async () => [],
    findMany: async () => [],
  },
  externalOrder: {
    findFirst: async () => null,
    count: async () => 0,
  },
  globalReorderSettings: {
    findUnique: async () => null,
  },
  location: {
    findMany: async () => [],
  },
  $queryRaw: async () => [{ ok: 1 }],
};

export default prismaMock;
