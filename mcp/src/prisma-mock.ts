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
 *   - orderAttributionAttempt / auditLog — the reconciliation lane's recording boundary
 *     and drill-down (pack C5.1).
 *   - location.findUnique / company.findMany — assistant A2 (pack C8 / C9): the
 *     get_stock_asof location resolve + the movement filters' location name, and the
 *     company names on every per-company sales coverage entry.
 *   - analyticsRebuildRun.findFirst / findMany — assistant A2 (pack C7, C15): the sales
 *     rebuild's run history behind the freshness note and get_data_freshness'
 *     lastSucceededAt — the newest success read directly, then the attempts after it.
 *   - externalOrder.groupBy / productLink.findMany / bundleComponent.findMany — assistant
 *     A2 FR1 (pack C14): the reorder order signal's link check (the caller's stores from its
 *     orders, then the listings on them) and its unlinked-order count (externalOrder.count).
 *   - $queryRaw            — the /healthz SELECT 1 probe AND the reconciliation totals
 *     read, told apart by the statement text (see the dispatcher below).
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
    // Wave-2: getReceipts (get_movement_series receipts:true) counts before paging.
    count: async () => 0,
  },
  analyticsRebuildState: {
    findUnique: async () => null,
  },
  // A2 C7: the sales rebuild run history (no runs on record in the mock build). A2 C15: the
  // two reads answer that empty table faithfully — no success (null), no attempts ([]).
  analyticsRebuildRun: {
    findFirst: async () => null,
    findMany: async () => [],
  },
  fulfillmentSyncState: {
    findMany: async () => [],
  },
  productStockSnapshot: {
    // Wave-2: get_stock_asof reads _min AND _max for dataStart + watermark.
    aggregate: async () => ({ _min: {}, _max: {} }),
    groupBy: async () => [],
    findMany: async () => [],
  },
  // Wave-2: compare_periods sales metrics read ProductSalesFact aggregates.
  // quality+reach W2 (Task 2.6 consolidation): `groupBy` is the surface get_sales'
  // product grain + zero-row firstSaleDayKey lookup and compare_periods' by_product
  // mode all read. The inline jest mock gained it per-task; the BUILT bundle needs it
  // too or the shipped artifact 500s on those tools while every jest round-trip passes
  // (an inline round-trip structurally cannot detect a missing build-mock method).
  productSalesFact: {
    aggregate: async () => ({ _min: {}, _max: {}, _sum: {}, _count: {} }),
    groupBy: async () => [],
  },
  externalOrder: {
    findFirst: async () => null,
    count: async () => 0,
    // Wave-2: get_order_pipeline reads orders through the PII allowlist.
    findMany: async () => [],
    // A2 C14: the caller's stores, as the integrationIds of its own orders (ids only).
    groupBy: async () => [],
  },
  // Wave-2: get_order_pipeline reads order items through the PII allowlist.
  externalOrderItem: {
    findMany: async () => [],
  },
  globalReorderSettings: {
    findUnique: async () => null,
  },
  location: {
    findMany: async () => [],
    // A2 C9 / C8: the get_stock_asof locationId resolve (null -> notFound("location")) and
    // the movement filters echo's location name.
    findUnique: async () => null,
  },
  // A2 C8: the company names on every per-company sales coverage entry ({ id, name } only,
  // over the caller's own companies).
  company: {
    findMany: async () => [],
  },
  // A2 C14: the listings that make a no-fact product LINKED (internalProductId only).
  productLink: {
    findMany: async () => [],
  },
  bundleComponent: {
    findMany: async () => [],
  },
  // Wave-3 composites (get_product_overview / get_business_snapshot) fan out to the
  // module reads ALREADY covered above (product / product_locations / inventory_logs /
  // productSalesFact / externalOrder(+Item) / analyticsRebuildState / fulfillmentSyncState
  // / productStockSnapshot / globalReorderSettings / systemSetting / location), so the
  // mock build serves both composites end-to-end with the benign shapes above — no new
  // delegate is required.
  //
  // Reconciliation lane (pack C5.1): get_order_reconciliation reads the recording
  // boundary (`ATTEMPTS_RECORDING_SINCE` — the first attempt row) through this delegate,
  // and the drill-down reads the audit event that wrote a batch.
  orderAttributionAttempt: {
    findFirst: async () => null,
    findMany: async () => [],
  },
  auditLog: {
    findMany: async () => [],
  },
  // A DISPATCHER on the statement text, because two unrelated reads now arrive here.
  // The /healthz probe wants its scalar row; the reconciliation batch-summary read wants
  // a ROW SET, and handing it `[{ ok: 1 }]` would produce a "batch" with no id and no
  // time. Every reconciliation raw read uses the OBJECT call form
  // `prisma.$queryRaw<T>(Prisma.sql\`…\`)` (C2a.4), so the tag object's `.sql` is what to
  // read — `String(first)` on a Prisma.Sql yields "[object Object]" and would match
  // nothing.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  $queryRaw: async (first: any) => {
    const sql =
      typeof first === "object" && first !== null && "sql" in first ? first.sql : String(first);
    const isReconciliationRead =
      (sql.includes("inventory_logs") || sql.includes("external_order_items")) &&
      sql.includes("GROUP BY");
    return isReconciliationRead ? [] : [{ ok: 1 }];
  },
};

export default prismaMock;
