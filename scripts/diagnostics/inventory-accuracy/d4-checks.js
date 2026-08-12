//
// Phase 0a / D4 — the cheap one-shot checks.
//
//  - MIRROR GAP: products.quantity (the legacy column) vs the location-1
//    product_locations row. Mass-update writes NEITHER the mirror NOR a version
//    increment, so if any surface still reads the legacy column it is a
//    too-high-direction suspect. This query exonerates or implicates the class.
//  - LOGTYPE CENSUS by ISO week since 2026-07-14: settles whether the
//    order-linked paths run at all post-deploy. The "zero SALE rows" claim is
//    SCOPED to the post-enum window — the SALE enum only exists since migration
//    20260709164143, so pre-July rows could not have been SALE.
//  - stockedOut set-rate over time: usage evidence about the workbench, not a
//    defect count.
//
const { query, int, date, bool } = require("./lib/db");
const { figure, disclosure, table } = require("./lib/artifact");
const { weekStartKey, monthKey } = require("./lib/date-buckets");

const check = "d4-checks";
const title = "Mirror gap, logType census, stockedOut set-rate";
const purpose =
  "Three cheap one-shot questions with expensive consequences: does the legacy " +
  "products.quantity mirror still disagree with per-location truth (and in which " +
  "direction); do the order-linked ledger paths run at all since the post-enum deploy; " +
  "and how often is the workbench's stockedOut flag actually set.";

/** The SALE enum's migration; the census is scoped to on/after the deploy. */
const SALE_ENUM_MIGRATION = "20260709164143_change_tracking_foundation (deployed ~2026-07-14)";
const DEFAULT_LOCATION_ID = 1;

async function run(ctx) {
  const { prisma, opts } = ctx;
  const notes = [];

  // ---- mirror gap ---------------------------------------------------------
  const mirrorRows = await query(
    prisma,
    `SELECT p.id AS productId,
            p.quantity AS legacyQuantity,
            pl.quantity AS locationQuantity,
            pl.version AS locationVersion,
            (p.deletedAt IS NOT NULL) AS isSoftDeleted
       FROM products p
       LEFT JOIN product_locations pl
         ON pl.productId = p.id AND pl.locationId = ?
      WHERE pl.id IS NULL OR p.quantity <> pl.quantity`,
    [DEFAULT_LOCATION_ID]
  );
  const productTotals = await query(
    prisma,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN p.deletedAt IS NOT NULL THEN 1 ELSE 0 END) AS softDeleted
       FROM products p`
  );

  const mirrorLive = [];
  let mirrorSoftDeleted = 0;
  let missingLocationRow = 0;
  for (const r of mirrorRows) {
    if (bool(r.isSoftDeleted)) {
      mirrorSoftDeleted += 1;
      continue;
    }
    const hasLocationRow = r.locationQuantity !== null && r.locationQuantity !== undefined;
    if (!hasLocationRow) missingLocationRow += 1;
    mirrorLive.push({
      productId: int(r.productId),
      legacyQuantity: int(r.legacyQuantity),
      locationQuantity: hasLocationRow ? int(r.locationQuantity) : null,
      difference: hasLocationRow ? int(r.legacyQuantity) - int(r.locationQuantity) : null,
      locationVersion: hasLocationRow ? int(r.locationVersion) : null,
      note: hasLocationRow ? "mismatch" : "no location-1 product_locations row",
    });
  }
  const mirrorTooHigh = mirrorLive.filter((r) => r.difference !== null && r.difference > 0);
  const mirrorTooLow = mirrorLive.filter((r) => r.difference !== null && r.difference < 0);

  const mirrorDisclosures = [
    disclosure(
      "soft_deleted_products_excluded",
      mirrorSoftDeleted,
      "Mismatching products with deletedAt set — excluded from the live figures and " +
        "counted here instead."
    ),
    disclosure(
      "products_without_location_1_row",
      missingLocationRow,
      "Products with no product_locations row at location 1 at all. The difference is " +
        "null (unknown), NOT zero — there is nothing to compare against."
    ),
    disclosure(
      "location_scope",
      DEFAULT_LOCATION_ID,
      "The legacy products.quantity column mirrors ONE location (the default, id 1). " +
        "Stock at other locations is outside this comparison by construction."
    ),
  ];

  // ---- logType census -----------------------------------------------------
  const censusSince = opts.censusSince;
  const censusRows = await query(
    prisma,
    `SELECT DATE_FORMAT(il.changeTime, '%Y-%m-%d') AS dayKey, il.logType,
            COUNT(*) AS rowCount,
            COALESCE(SUM(CASE WHEN il.delta > 0 THEN il.delta ELSE 0 END), 0) AS positiveUnits,
            COALESCE(SUM(CASE WHEN il.delta < 0 THEN -il.delta ELSE 0 END), 0) AS negativeUnits
       FROM inventory_logs il
      WHERE il.changeTime >= ?
      GROUP BY DATE_FORMAT(il.changeTime, '%Y-%m-%d'), il.logType`,
    [`${censusSince} 00:00:00`]
  );
  const censusByWeek = new Map();
  for (const r of censusRows) {
    const wk = weekStartKey(r.dayKey);
    const key = `${wk}|${r.logType}`;
    if (!censusByWeek.has(key)) {
      censusByWeek.set(key, {
        isoWeekStart: wk,
        logType: r.logType,
        rowCount: 0,
        positiveUnits: 0,
        negativeUnits: 0,
      });
    }
    const b = censusByWeek.get(key);
    b.rowCount += int(r.rowCount);
    b.positiveUnits += int(r.positiveUnits);
    b.negativeUnits += int(r.negativeUnits);
  }

  const lifetimeCensus = await query(
    prisma,
    `SELECT il.logType, COUNT(*) AS rowCount,
            MIN(il.changeTime) AS firstAt, MAX(il.changeTime) AS lastAt
       FROM inventory_logs il
      GROUP BY il.logType`
  );

  const censusDisclosures = [
    disclosure(
      "sale_enum_floor",
      SALE_ENUM_MIGRATION,
      "The SALE logType value only EXISTS since this migration. Rows before it could " +
        "not have been SALE, so 'zero SALE rows' is a statement about the post-enum " +
        "window only — never about all history."
    ),
    disclosure(
      "census_since",
      censusSince,
      "Lower bound (--census-since, default 2026-07-14 = the post-enum deploy)."
    ),
  ];

  // ---- stockedOut set-rate ------------------------------------------------
  const stockedOutRows = await query(
    prisma,
    `SELECT DATE_FORMAT(COALESCE(eo.externalCreatedAt, eo.createdAt), '%Y-%m-%d') AS dayKey,
            eo.companyId, eo.integrationId,
            COUNT(*) AS orders,
            SUM(CASE WHEN eo.stockedOut = 1 THEN 1 ELSE 0 END) AS stockedOutOrders,
            SUM(CASE WHEN eo.stockedOutAt IS NOT NULL THEN 1 ELSE 0 END) AS stockedOutAtSet
       FROM external_orders eo
      GROUP BY DATE_FORMAT(COALESCE(eo.externalCreatedAt, eo.createdAt), '%Y-%m-%d'),
               eo.companyId, eo.integrationId`
  );
  const byMonth = new Map();
  let ordersTotal = 0;
  let stockedOutTotal = 0;
  for (const r of stockedOutRows) {
    if (!r.dayKey) continue;
    const key = `${monthKey(r.dayKey)}|${r.companyId}|${r.integrationId}`;
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        month: monthKey(r.dayKey),
        companyId: r.companyId,
        integrationId: r.integrationId,
        orders: 0,
        stockedOutOrders: 0,
        setRatePercent: 0,
      });
    }
    const b = byMonth.get(key);
    b.orders += int(r.orders);
    b.stockedOutOrders += int(r.stockedOutOrders);
    ordersTotal += int(r.orders);
    stockedOutTotal += int(r.stockedOutOrders);
  }
  const stockedOutByMonth = Array.from(byMonth.values())
    .map((b) => ({
      ...b,
      setRatePercent: b.orders > 0 ? Math.round((b.stockedOutOrders / b.orders) * 10000) / 100 : null,
    }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

  const stockedOutFirstLast = await query(
    prisma,
    `SELECT MIN(stockedOutAt) AS firstAt, MAX(stockedOutAt) AS lastAt
       FROM external_orders WHERE stockedOutAt IS NOT NULL`
  );

  const stockedOutDisclosures = [
    disclosure(
      "backfilled_at_migration",
      "20260411_add_stocked_out",
      "That migration BACKFILLED stockedOut/stockedOutAt from fulfilledAt for orders " +
        "that already had fulfilled items. A set flag dated before 2026-04-11 is " +
        "backfill, not workbench usage."
    ),
    disclosure(
      "order_bucket_anchor",
      "COALESCE(externalCreatedAt, createdAt)",
      "Orders are bucketed by their own creation date (the order-pipeline precedent), " +
        "NOT by stockedOutAt — the rate answers 'of the orders from month M, how many " +
        "were ever stocked out'."
    ),
    disclosure(
      "stocked_out_at_first_last",
      `${date(stockedOutFirstLast[0]?.firstAt)?.toISOString() ?? "none"} .. ` +
        `${date(stockedOutFirstLast[0]?.lastAt)?.toISOString() ?? "none"}`,
      "MIN/MAX stockedOutAt across all orders, backfill included."
    ),
  ];

  const sections = {
    mirrorGap: {
      mismatchedProducts: figure(
        mirrorLive.length,
        `Live (not soft-deleted) products where products.quantity differs from the ` +
          `location-${DEFAULT_LOCATION_ID} product_locations.quantity, or where that ` +
          `location row is absent entirely.`,
        mirrorDisclosures
      ),
      productsTotal: figure(
        int(productTotals[0]?.total),
        "All rows in products.",
        [
          disclosure(
            "soft_deleted",
            int(productTotals[0]?.softDeleted),
            "products with deletedAt set."
          ),
        ]
      ),
      legacyTooHigh: figure(
        mirrorTooHigh.length,
        "Products where the LEGACY column reads HIGHER than the per-location truth — " +
          "the direction that matches the reported symptom if any surface still reads it.",
        mirrorDisclosures
      ),
      legacyTooLow: figure(
        mirrorTooLow.length,
        "Products where the legacy column reads LOWER than the per-location truth.",
        mirrorDisclosures
      ),
      detail: table(
        mirrorLive
          .sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0))
          .slice(0, opts.top),
        `The ${opts.top} largest mirror gaps by absolute difference.`,
        {
          difference:
            "products.quantity - product_locations.quantity (location 1). null when there " +
            "is no location row to compare against — unknown, not zero.",
          locationVersion:
            "product_locations.version, the optimistic-lock counter. Mass-update does not " +
            "increment it, so a low version next to heavy movement is itself a signal.",
        },
        mirrorDisclosures
      ),
    },

    logTypeCensus: {
      byIsoWeek: table(
        Array.from(censusByWeek.values()).sort((a, b) =>
          a.isoWeekStart === b.isoWeekStart
            ? a.logType.localeCompare(b.logType)
            : a.isoWeekStart < b.isoWeekStart
              ? -1
              : 1
        ),
        `inventory_logs rows by logType and ISO week since ${censusSince}. The ISO week ` +
          "is keyed by its UTC Monday (the house convention in lib/analytics/date-grain.ts). " +
          "This settles whether the order-linked paths run at all post-deploy.",
        {
          rowCount: "COUNT(*) of ledger rows in that (week, logType) cell.",
          positiveUnits: "SUM(delta) over positive rows in the cell.",
          negativeUnits: "SUM(-delta) over negative rows in the cell.",
        },
        censusDisclosures
      ),
      lifetimeByLogType: table(
        lifetimeCensus.map((r) => ({
          logType: r.logType,
          rowCount: int(r.rowCount),
          firstAt: date(r.firstAt)?.toISOString() ?? null,
          lastAt: date(r.lastAt)?.toISOString() ?? null,
        })),
        "Whole-history counts per logType, with first and last occurrence — the context " +
          "the windowed census needs to be read honestly.",
        {
          firstAt: "MIN(changeTime) for the logType. Compare against the enum's migration date.",
        },
        censusDisclosures
      ),
    },

    stockedOutUsage: {
      setRatePercent: figure(
        ordersTotal > 0 ? Math.round((stockedOutTotal / ordersTotal) * 10000) / 100 : null,
        "Percent of ALL external orders with stockedOut = true. This is a finding about " +
          "workbench usage, not a defect count.",
        stockedOutDisclosures
      ),
      ordersTotal: figure(ordersTotal, "All rows in external_orders."),
      stockedOutOrders: figure(stockedOutTotal, "external_orders rows with stockedOut = true."),
      byMonth: table(
        stockedOutByMonth,
        "Set-rate over time, per store (companyId + integrationId), bucketed by the " +
          "order's own creation month.",
        {
          setRatePercent:
            "stockedOutOrders / orders * 100 for that month and store. null when the " +
            "month has no orders (unknown, not 0%).",
        },
        stockedOutDisclosures
      ),
    },
  };

  notes.push(
    "The mirror gap and the version counter share one cause: mass-update writes stock " +
      "directly without the mirror write or the version increment. Registered by the spec " +
      "for the full lane (G2-8/OC-11a) — this check measures its blast radius."
  );

  return {
    sections,
    notes,
    meta: { mirrorMismatches: mirrorLive.length, stockedOutSetRate: stockedOutTotal },
  };
}

module.exports = { check, title, purpose, run, DEFAULT_LOCATION_ID };
