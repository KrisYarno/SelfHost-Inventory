/**
 * launch-gate/seed.ts — the sentinel seed + its exported manifest (spec C7 "Sentinel
 * seed"; contract pack T9; seam S12).
 *
 * `GATE_SEED` is the contract: every matrix IMPORTS ids, emails, passwords, token
 * plaintexts and sentinel values from here and never re-literals them. The seeding
 * function below is the only thing that writes them.
 *
 * SENTINELS are per-company numeric values in disjoint bands — company B draws from
 * 9_100_000-9_199_999 (never a small integer that could coincide with a quantity,
 * an id or a page size), company A from 1_000-99_999. Uniqueness is asserted at
 * insert time, so a copy-paste that reuses a value fails the seed instead of
 * silently weakening the row-1 leak scan.
 *
 * PROVIDER CONFIG is the harness's most fragile contract: `resolveSurfaceModel`
 * reads `system_settings.aiSurfaceConfig` as a JSON STRING and requires the OLLAMA
 * row to be enabled, to carry `baseUrl`, and to list the model in `enabledModels`.
 * Get any of those wrong and every turn 409s AI_UNCONFIGURED.
 */

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
// RELATIVE, not `@/lib/...`: jest loads globalSetup through `requireOrImportModule`,
// which applies the transform but NOT `moduleNameMapper` — an aliased VALUE import
// anywhere in the setup graph fails to resolve at boot. Type-only imports are erased
// and unaffected; this one is a real runtime import.
import { hashPassword } from "../lib/auth-helpers";
import { assertGateDatabaseUrl } from "./state";

/** sha256 hex of the FULL token string — recomputed here rather than imported from
 *  `mcp/src/auth.ts` (which sits outside this tsconfig project, and which the seed
 *  should not share a code path with anyway). */
function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export type GateActor = {
  userId: number;
  email: string;
  password: string;
  companyIds: readonly string[];
};

export type GateSeedManifest = {
  actors: Record<"memberA" | "zeroUser" | "admin", GateActor>;
  companies: { A: string; B: string; noSales: string };
  apiTokens: Record<"memberA" | "admin" | "revoked", { id: string; plaintext: string }>;
  fixtures: {
    approvedActiveProductId: number;
    approvedArchivedProductId: number;
    pendingReviewProductId: number;
    negativeStockInLogId: number;
    correctionLogId: number;
    reorderConfigIds: readonly number[];
    staggeredCompanyIds: readonly string[];
    // --- ADDITIVE (Task 1.7, declared) — matrix row 2 needs data the 1.5 seed did
    //     not carry. Nothing above changed value or meaning. ---
    /** The approved-ACTIVE population `reorder_report` counts as `coverage.total`
     *  (spec C5). Seeded to span the urgency buckets: REORDER_NOW / CRITICAL /
     *  APPROACHING / healthy / two no_demand_signal. */
    reorderCohortProductIds: readonly number[];
    /** Low-stock alert whose `lowStockThreshold` column is NULL -> thresholdSource
     *  `system_default` (spec C8). */
    lowStockInheritProductId: number;
    /** Low-stock alert whose column is an EXPLICIT value EQUAL to the system default
     *  -> thresholdSource `product_override`: the exact case C8's deleted
     *  equality-inference used to get wrong. */
    lowStockExplicitProductId: number;
    /** The system default low-stock threshold, seeded as a real setting row so the
     *  oracle reads it rather than assuming the code's fallback. */
    lowStockDefaultThreshold: number;
    /** Ledger row id carrying the NOT-APPROVED product's movement (row 2k). */
    unapprovedLedgerLogId: number;
    /** Magnitudes only the NOT-APPROVED product contributes. They must never appear
     *  in ANY payload and must never move a total or a data-start (row 2k). */
    unapprovedLedgerUnits: number;
    unapprovedSalesQty: number;
  };
  sentinels: { companyA: readonly string[]; companyB: readonly string[] };
};

const COMPANY_A = "gatecompanyaaaaaaaaaaaaaa";
const COMPANY_B = "gatecompanybbbbbbbbbbbbbb";
const COMPANY_NO_SALES = "gatecompanynosalesnosales";

/** `invmcp_` + exactly 43 base64url characters (mcp/src/auth.ts BASE64URL_BODY). */
function gateTokenPlaintext(tag: string): string {
  return `invmcp_${(tag + "0".repeat(43)).slice(0, 43)}`;
}

export const AI_SURFACE_CONFIG_VALUE =
  '{"default":{"providerKind":"OLLAMA","model":"gate-scripted"}}';
export const GATE_MODEL = "gate-scripted";
export const GATE_SHIM_BASE_URL = "http://127.0.0.1:3102";

export const GATE_SEED: GateSeedManifest = {
  actors: {
    // NOTE (deviation, reported): memberA holds A **and** the no-sales company. The
    // FD2-2 per-company degradation row needs a caller whose scope contains a
    // company with no sales facts, and admin's scope is pinned to exactly A+B by
    // matrix row 1. memberA still sees ZERO company-B sentinels, which is what
    // "A-only" is actually asserting.
    memberA: {
      userId: 9001,
      email: "gate-member-a@advancedresearchpep.com",
      password: "GateMemberA-2026",
      companyIds: [COMPANY_A, COMPANY_NO_SALES],
    },
    zeroUser: {
      userId: 9002,
      email: "gate-zero-user@advancedresearchpep.com",
      password: "GateZeroUser-2026",
      companyIds: [],
    },
    admin: {
      userId: 9003,
      email: "gate-admin@advancedresearchpep.com",
      password: "GateAdmin-2026",
      companyIds: [COMPANY_A, COMPANY_B],
    },
  },
  companies: { A: COMPANY_A, B: COMPANY_B, noSales: COMPANY_NO_SALES },
  apiTokens: {
    memberA: { id: "gatetokenmembera000000000", plaintext: gateTokenPlaintext("gateMemberA") },
    admin: { id: "gatetokenadmin00000000000", plaintext: gateTokenPlaintext("gateAdmin") },
    revoked: { id: "gatetokenrevoked000000000", plaintext: gateTokenPlaintext("gateRevoked") },
  },
  fixtures: {
    approvedActiveProductId: 9101,
    approvedArchivedProductId: 9102,
    pendingReviewProductId: 9103,
    negativeStockInLogId: 9201,
    correctionLogId: 9202,
    reorderConfigIds: [9301, 9302, 9303],
    staggeredCompanyIds: [COMPANY_A, COMPANY_B],
    reorderCohortProductIds: [9101, 9104, 9105, 9106, 9108, 9109],
    lowStockInheritProductId: 9108,
    lowStockExplicitProductId: 9109,
    lowStockDefaultThreshold: 10,
    unapprovedLedgerLogId: 9230,
    // SEVEN digits, disjoint from BOTH sentinel bands (A 1_000-99_999, B
    // 9_100_000-9_199_999). A short numeric literal is not scannable over a
    // transcript that also carries hex ids — "4747" really did collide with a
    // UUID toolCallId in a trial run.
    unapprovedLedgerUnits: 8_414_141,
    unapprovedSalesQty: 8_474_747,
  },
  sentinels: {
    // A: product_sales_facts.orderedQty · external_order_items.quantity ·
    //    external_orders.orderNumber
    companyA: ["1301", "1302", "1303"],
    // B: the same three carriers, from the disjoint high band.
    companyB: ["9100101", "9100202", "9100303"],
  },
};

const A_BAND = { min: 1_000, max: 99_999 };
const B_BAND = { min: 9_100_000, max: 9_199_999 };

/** Insert-time uniqueness + band assertion (pack T9). Runs BEFORE any write, so a
 *  broken sentinel set can never reach the database. */
export function assertSentinelIntegrity(): void {
  const all = [...GATE_SEED.sentinels.companyA, ...GATE_SEED.sentinels.companyB];
  if (new Set(all).size !== all.length) {
    throw new Error("GATE_SEED sentinels are not unique — the row-1 leak scan would be unsound");
  }
  for (const value of GATE_SEED.sentinels.companyA) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < A_BAND.min || numeric > A_BAND.max) {
      throw new Error(`company-A sentinel ${value} is outside ${A_BAND.min}-${A_BAND.max}`);
    }
  }
  for (const value of GATE_SEED.sentinels.companyB) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < B_BAND.min || numeric > B_BAND.max) {
      throw new Error(`company-B sentinel ${value} is outside ${B_BAND.min}-${B_BAND.max}`);
    }
  }
}

/** UTC day key `YYYY-MM-DD`, `daysAgo` days before today (the house dayKey shape). */
function dayKey(back: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Seed the throwaway gate database. Idempotent only in the trivial sense — it runs
 * exactly once per container, immediately after `prisma migrate deploy`.
 */
export async function seedGateDatabase(databaseUrl: string): Promise<void> {
  assertGateDatabaseUrl(databaseUrl);
  assertSentinelIntegrity();

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const [aSentinelSales, aSentinelQty, aSentinelOrderNo] = GATE_SEED.sentinels.companyA;
    const [bSentinelSales, bSentinelQty, bSentinelOrderNo] = GATE_SEED.sentinels.companyB;

    // --- Locations (users.defaultLocationId FKs into this) -------------------
    await prisma.location.createMany({
      data: [
        { id: 1, name: "Gate Main" },
        { id: 2, name: "Gate Overflow" },
      ],
    });

    // --- Actors -------------------------------------------------------------
    const hashes = await Promise.all(
      (["memberA", "zeroUser", "admin"] as const).map((key) =>
        hashPassword(GATE_SEED.actors[key].password),
      ),
    );
    await prisma.user.createMany({
      data: (["memberA", "zeroUser", "admin"] as const).map((key, index) => ({
        id: GATE_SEED.actors[key].userId,
        username: key.toLowerCase(),
        email: GATE_SEED.actors[key].email,
        passwordHash: hashes[index],
        isAdmin: key === "admin",
        isApproved: true,
        defaultLocationId: 1,
      })),
    });

    // --- Companies + memberships --------------------------------------------
    await prisma.company.createMany({
      data: [
        { id: COMPANY_A, name: "Gate Company A", slug: "gate-company-a" },
        { id: COMPANY_B, name: "Gate Company B", slug: "gate-company-b" },
        { id: COMPANY_NO_SALES, name: "Gate Company NoSales", slug: "gate-company-nosales" },
      ],
    });
    await prisma.userCompany.createMany({
      data: (["memberA", "zeroUser", "admin"] as const).flatMap((key) =>
        GATE_SEED.actors[key].companyIds.map((companyId) => ({
          userId: GATE_SEED.actors[key].userId,
          companyId,
        })),
      ),
    });

    // --- Integrations (one per company; orders + sales facts FK into these) ---
    const integrationOf = (companyId: string): string => `gateintegration-${companyId.slice(-6)}`;
    await prisma.integration.createMany({
      data: [COMPANY_A, COMPANY_B, COMPANY_NO_SALES].map((companyId) => ({
        id: integrationOf(companyId),
        companyId,
        platform: "WOOCOMMERCE",
        name: `Gate store ${companyId.slice(-6)}`,
        storeUrl: `http://gate-${companyId.slice(-6)}.invalid`,
      })),
    });

    // --- Products (lifecycle triad + the reorder cohort) ---------------------
    await prisma.product.createMany({
      data: [
        {
          id: GATE_SEED.fixtures.approvedActiveProductId,
          name: "Gate Widget Alpha 10 mg",
          baseName: "Gate Widget Alpha",
          variant: "10 mg",
          unit: "mg",
          quantity: 120,
          location: 1,
          lowStockThreshold: 20,
          costPrice: "4.50",
          retailPrice: "19.00",
          approvalStatus: "APPROVED",
        },
        {
          id: GATE_SEED.fixtures.approvedArchivedProductId,
          name: "Gate Widget Beta 20 mg",
          baseName: "Gate Widget Beta",
          variant: "20 mg",
          unit: "mg",
          quantity: 0,
          location: 1,
          costPrice: "6.25",
          retailPrice: "24.00",
          approvalStatus: "APPROVED",
          deletedAt: daysAgo(30),
        },
        {
          id: GATE_SEED.fixtures.pendingReviewProductId,
          name: "Gate Widget Gamma 30 mg",
          baseName: "Gate Widget Gamma",
          variant: "30 mg",
          unit: "mg",
          quantity: 7,
          location: 1,
          approvalStatus: "PENDING_REVIEW",
        },
        {
          id: 9104,
          name: "Gate Reorder Urgent 5 mg",
          baseName: "Gate Reorder Urgent",
          variant: "5 mg",
          quantity: 2,
          location: 1,
          lowStockThreshold: 25,
          costPrice: "2.00",
          approvalStatus: "APPROVED",
        },
        {
          id: 9105,
          name: "Gate Reorder Soon 15 mg",
          baseName: "Gate Reorder Soon",
          variant: "15 mg",
          quantity: 40,
          location: 1,
          lowStockThreshold: 25,
          costPrice: "3.00",
          approvalStatus: "APPROVED",
        },
        {
          id: 9106,
          name: "Gate Reorder Healthy 25 mg",
          baseName: "Gate Reorder Healthy",
          variant: "25 mg",
          quantity: 500,
          location: 1,
          lowStockThreshold: 25,
          costPrice: "1.25",
          approvalStatus: "APPROVED",
        },
        // ADDITIVE (Task 1.7): the two low-stock alert rows that make spec C8's
        // thresholdSource observable. 9108 INHERITS (column NULL); 9109 carries an
        // EXPLICIT override that happens to EQUAL the system default — the case the
        // deleted equality inference reported as `system_default`.
        {
          id: 9108,
          name: "Gate Threshold Inherit 5 mg",
          baseName: "Gate Threshold Inherit",
          variant: "5 mg",
          quantity: 3,
          location: 1,
          approvalStatus: "APPROVED",
        },
        {
          id: 9109,
          name: "Gate Threshold Explicit 5 mg",
          baseName: "Gate Threshold Explicit",
          variant: "5 mg",
          quantity: 3,
          location: 1,
          lowStockThreshold: 10,
          costPrice: "7.00",
          approvalStatus: "APPROVED",
        },
      ],
    });
    await prisma.product_locations.createMany({
      data: [
        { productId: 9101, locationId: 1, quantity: 120, minQuantity: 20 },
        { productId: 9103, locationId: 1, quantity: 7, minQuantity: 0 },
        { productId: 9104, locationId: 1, quantity: 2, minQuantity: 25 },
        { productId: 9105, locationId: 1, quantity: 40, minQuantity: 25 },
        { productId: 9106, locationId: 1, quantity: 500, minQuantity: 25 },
        // ADDITIVE (Task 1.7) — the two C8 threshold products.
        { productId: 9108, locationId: 1, quantity: 3, minQuantity: 0 },
        { productId: 9109, locationId: 1, quantity: 3, minQuantity: 0 },
      ],
    });

    // --- C12 ledger fixtures (CONSUMED by matrix row 2g) ---------------------
    await prisma.inventory_logs.createMany({
      data: [
        {
          id: GATE_SEED.fixtures.negativeStockInLogId,
          productId: GATE_SEED.fixtures.approvedActiveProductId,
          userId: GATE_SEED.actors.admin.userId,
          delta: -14,
          logType: "STOCK_IN",
          changeTime: daysAgo(12),
          locationId: 1,
          actorKind: "USER",
        },
        {
          id: GATE_SEED.fixtures.correctionLogId,
          productId: GATE_SEED.fixtures.approvedActiveProductId,
          userId: GATE_SEED.actors.admin.userId,
          delta: -9,
          logType: "CORRECTION",
          reasonCode: "CORRECTION",
          changeTime: daysAgo(9),
          locationId: 1,
          actorKind: "USER",
        },
        {
          id: 9203,
          productId: 9104,
          userId: GATE_SEED.actors.admin.userId,
          delta: -30,
          logType: "SALE",
          changeTime: daysAgo(6),
          locationId: 1,
          actorKind: "USER",
        },
      ],
    });

    // --- ADDITIVE (Task 1.7, declared) — DEMAND EVIDENCE ---------------------
    //
    // WHY: `minEvidenceEvents` is 3 (the migrated global default), and the 1.5 seed
    // gave every product at most ONE qualifying outbound row. Every product therefore
    // fell out of reorder_report as `insufficient_history`, so the C5 coverage sweep
    // (spec C7 row 2b) had nothing but zeros to assert and no `suggested` row existed
    // to carry a `demandMix` (row 2g). These rows give the four configured products
    // >= 3 qualifying events each, landing them on DIFFERENT urgency buckets.
    //
    // NOTHING SEEDED ABOVE CHANGES. Every row here is a new id on an existing product,
    // and every value the matrices assert is RECOMPUTED from these rows by the oracle
    // rather than hard-coded — the arithmetic below is the intent, not the assertion.
    //
    //   9101  94 units / 3 events over 13 covered days -> REORDER_NOW (stock 120)
    //         and its demandMix is stockInReversal 14 + adjustmentUnclassified 80,
    //         while its outboundMix30 additionally holds the CORRECTION row's 9 —
    //         the C12 partition difference, on real rows.
    //   9104  60 units / 4 events over 31 covered days -> CRITICAL (stock 2)
    //   9105  42 units / 3 events over 21 covered days -> APPROACHING (stock 40)
    //   9106  15 units / 3 events over 26 covered days -> healthy (reorderPoint
    //         override 0), i.e. urgency null unless includeHealthy asks for it
    //   9108/9109 get NO rows -> no_demand_signal, the `unavailable` bucket
    await prisma.inventory_logs.createMany({
      data: [
        // 9101 — unclassified adjustments (this shop's real shipping record).
        { id: 9210, productId: 9101, userId: GATE_SEED.actors.admin.userId, delta: -40, logType: "ADJUSTMENT", changeTime: daysAgo(8), locationId: 1, actorKind: "USER" },
        { id: 9211, productId: 9101, userId: GATE_SEED.actors.admin.userId, delta: -40, logType: "ADJUSTMENT", changeTime: daysAgo(4), locationId: 1, actorKind: "USER" },
        // 9104 — plain sales.
        { id: 9212, productId: 9104, userId: GATE_SEED.actors.admin.userId, delta: -10, logType: "SALE", changeTime: daysAgo(30), locationId: 1, actorKind: "USER" },
        { id: 9213, productId: 9104, userId: GATE_SEED.actors.admin.userId, delta: -10, logType: "SALE", changeTime: daysAgo(20), locationId: 1, actorKind: "USER" },
        { id: 9214, productId: 9104, userId: GATE_SEED.actors.admin.userId, delta: -10, logType: "SALE", changeTime: daysAgo(10), locationId: 1, actorKind: "USER" },
        // 9105 — plain sales.
        { id: 9215, productId: 9105, userId: GATE_SEED.actors.admin.userId, delta: -14, logType: "SALE", changeTime: daysAgo(20), locationId: 1, actorKind: "USER" },
        { id: 9216, productId: 9105, userId: GATE_SEED.actors.admin.userId, delta: -14, logType: "SALE", changeTime: daysAgo(12), locationId: 1, actorKind: "USER" },
        { id: 9217, productId: 9105, userId: GATE_SEED.actors.admin.userId, delta: -14, logType: "SALE", changeTime: daysAgo(4), locationId: 1, actorKind: "USER" },
        // 9106 — plain sales, small enough to stay healthy against a 500 stock.
        { id: 9218, productId: 9106, userId: GATE_SEED.actors.admin.userId, delta: -5, logType: "SALE", changeTime: daysAgo(25), locationId: 1, actorKind: "USER" },
        { id: 9219, productId: 9106, userId: GATE_SEED.actors.admin.userId, delta: -5, logType: "SALE", changeTime: daysAgo(15), locationId: 1, actorKind: "USER" },
        { id: 9220, productId: 9106, userId: GATE_SEED.actors.admin.userId, delta: -5, logType: "SALE", changeTime: daysAgo(5), locationId: 1, actorKind: "USER" },
        // The NOT-APPROVED product's movement (row 2k). Every assistant read narrows
        // by the approved-id set, so this row must move NO total anywhere — and it
        // must be COUNTED by the `excludedUnapprovedProducts` census. Its magnitude is
        // deliberately distinctive so the matrices can also grep for its absence.
        {
          id: GATE_SEED.fixtures.unapprovedLedgerLogId,
          productId: GATE_SEED.fixtures.pendingReviewProductId,
          userId: GATE_SEED.actors.admin.userId,
          delta: -GATE_SEED.fixtures.unapprovedLedgerUnits,
          logType: "ADJUSTMENT",
          changeTime: daysAgo(7),
          locationId: 1,
          actorKind: "USER",
        },
      ],
    });

    // --- Reorder policy ------------------------------------------------------
    // The migration chain already seeds row 1 (20260714220000_reorder_settings_seed_repair),
    // so this is an UPSERT — the gate takes the migrated defaults as given.
    await prisma.globalReorderSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
    await prisma.productReorderConfig.createMany({
      data: [
        { id: GATE_SEED.fixtures.reorderConfigIds[0], productId: 9104, leadTimeDays: 21, minOrderQuantity: 10 },
        { id: GATE_SEED.fixtures.reorderConfigIds[1], productId: 9105, customSafetyStockDays: 3, minOrderQuantity: 5 },
        { id: GATE_SEED.fixtures.reorderConfigIds[2], productId: 9106, reorderPointOverride: 0, minOrderQuantity: 1 },
      ],
    });

    // --- Product links (order items map through these) -----------------------
    await prisma.productLink.createMany({
      data: [COMPANY_A, COMPANY_B].map((companyId) => ({
        id: `gatelink-${companyId.slice(-6)}`,
        integrationId: integrationOf(companyId),
        internalProductId: GATE_SEED.fixtures.approvedActiveProductId,
        externalProductId: `gate-ext-${companyId.slice(-6)}`,
        externalSku: `GATE-SKU-${companyId.slice(-6).toUpperCase()}`,
        externalTitle: "Gate Widget Alpha",
      })),
    });

    // --- External orders: the orderNumber + item-quantity sentinels ----------
    await prisma.externalOrder.createMany({
      data: [
        {
          id: "gateorder-companya",
          companyId: COMPANY_A,
          integrationId: integrationOf(COMPANY_A),
          externalId: "gate-a-1",
          orderNumber: aSentinelOrderNo,
          nativeStatus: "completed",
          financialStatus: "paid",
          fulfillmentStatus: "fulfilled",
          total: "410.00",
          currency: "USD",
          rawPayload: {},
          internalStatus: "pending",
          externalCreatedAt: daysAgo(5),
        },
        // ADDITIVE (Task 1.7, declared): an OLD company-A order carrying an UNMAPPED
        // line item. Two contracts need it and neither was observable without it:
        //  · C7's `totalOrders` denominator is ALL-TIME while the sales figures beside
        //    it are WINDOWED — with every seeded order inside every seeded window, the
        //    two were indistinguishable and `attributionNote` asserted nothing.
        //  · `unattributedOrders` was structurally 0 (every item was isMapped), so the
        //    numerator could not be told from a broken read.
        {
          id: "gateorder-companya-old",
          companyId: COMPANY_A,
          integrationId: integrationOf(COMPANY_A),
          externalId: "gate-a-0",
          orderNumber: "gate-a-old-1",
          nativeStatus: "completed",
          financialStatus: "paid",
          fulfillmentStatus: "fulfilled",
          total: "10.00",
          currency: "USD",
          rawPayload: {},
          internalStatus: "pending",
          externalCreatedAt: daysAgo(200),
        },
        {
          id: "gateorder-companyb",
          companyId: COMPANY_B,
          integrationId: integrationOf(COMPANY_B),
          externalId: "gate-b-1",
          orderNumber: bSentinelOrderNo,
          nativeStatus: "completed",
          financialStatus: "paid",
          fulfillmentStatus: "fulfilled",
          total: "620.00",
          currency: "USD",
          rawPayload: {},
          internalStatus: "pending",
          externalCreatedAt: daysAgo(4),
        },
      ],
    });
    await prisma.externalOrderItem.createMany({
      data: [
        {
          id: "gateitem-companya",
          orderId: "gateorder-companya",
          externalItemId: "gate-a-item-1",
          externalProductId: `gate-ext-${COMPANY_A.slice(-6)}`,
          name: "Gate Widget Alpha",
          quantity: Number(aSentinelQty),
          price: "19.00",
          productLinkId: `gatelink-${COMPANY_A.slice(-6)}`,
          isMapped: true,
        },
        // ADDITIVE (Task 1.7): the UNMAPPED line item that makes the old order
        // "unattributed". No productLinkId — that is what unmapped means.
        {
          id: "gateitem-companya-old",
          orderId: "gateorder-companya-old",
          externalItemId: "gate-a-old-item-1",
          externalProductId: "gate-ext-unmapped",
          name: "Gate Unmapped Line",
          quantity: 1,
          price: "10.00",
          isMapped: false,
        },
        {
          id: "gateitem-companyb",
          orderId: "gateorder-companyb",
          externalItemId: "gate-b-item-1",
          externalProductId: `gate-ext-${COMPANY_B.slice(-6)}`,
          name: "Gate Widget Alpha",
          quantity: Number(bSentinelQty),
          price: "19.00",
          productLinkId: `gatelink-${COMPANY_B.slice(-6)}`,
          isMapped: true,
        },
      ],
    });

    // --- Sales facts: A starts 40 days back, B starts 10 (coverageShift), the
    //     no-sales company gets NOTHING (FD2-2 per-company degradation).
    await prisma.productSalesFact.createMany({
      data: [
        {
          productId: GATE_SEED.fixtures.approvedActiveProductId,
          companyId: COMPANY_A,
          integrationId: integrationOf(COMPANY_A),
          dayKey: dayKey(40),
          orderedQty: Number(aSentinelSales),
          fulfilledQty: 0,
          revenue: "410.00",
          orderCount: 1,
        },
        {
          productId: GATE_SEED.fixtures.approvedActiveProductId,
          companyId: COMPANY_A,
          integrationId: integrationOf(COMPANY_A),
          dayKey: dayKey(5),
          orderedQty: 12,
          fulfilledQty: 0,
          revenue: "228.00",
          orderCount: 2,
        },
        {
          productId: GATE_SEED.fixtures.approvedActiveProductId,
          companyId: COMPANY_B,
          integrationId: integrationOf(COMPANY_B),
          dayKey: dayKey(10),
          orderedQty: Number(bSentinelSales),
          fulfilledQty: 0,
          revenue: "620.00",
          orderCount: 1,
        },
        // ADDITIVE (Task 1.7, declared): the NOT-APPROVED product's sales fact, in
        // company A and EARLIER than A's first approved fact. Every assistant sales
        // read narrows by the approved-id set, so this row must (a) contribute to no
        // total, (b) NOT move `coverage.salesDataStart` back to this day, and (c) be
        // counted by `excludedUnapprovedProducts`. Without it the unapproved column of
        // the C13 policy table is asserted against an empty set.
        {
          productId: GATE_SEED.fixtures.pendingReviewProductId,
          companyId: COMPANY_A,
          integrationId: integrationOf(COMPANY_A),
          dayKey: dayKey(50),
          orderedQty: GATE_SEED.fixtures.unapprovedSalesQty,
          fulfilledQty: 0,
          revenue: "99.00",
          orderCount: 1,
        },
      ],
    });

    // --- MCP tokens (sha256 of the known plaintexts; one revoked) ------------
    await prisma.apiToken.createMany({
      data: [
        {
          id: GATE_SEED.apiTokens.memberA.id,
          name: "gate memberA token",
          tokenHash: hashToken(GATE_SEED.apiTokens.memberA.plaintext),
          createdByUserId: GATE_SEED.actors.admin.userId,
          ownerUserId: GATE_SEED.actors.memberA.userId,
        },
        {
          id: GATE_SEED.apiTokens.admin.id,
          name: "gate admin token",
          tokenHash: hashToken(GATE_SEED.apiTokens.admin.plaintext),
          createdByUserId: GATE_SEED.actors.admin.userId,
          ownerUserId: GATE_SEED.actors.admin.userId,
        },
        {
          id: GATE_SEED.apiTokens.revoked.id,
          name: "gate revoked token",
          tokenHash: hashToken(GATE_SEED.apiTokens.revoked.plaintext),
          createdByUserId: GATE_SEED.actors.admin.userId,
          ownerUserId: GATE_SEED.actors.memberA.userId,
          revokedAt: daysAgo(1),
        },
      ],
    });

    // --- Provider routing (get ANY of this wrong and every turn 409s) --------
    await prisma.aiProvider.create({
      data: {
        id: "gateproviderollama000000",
        kind: "OLLAMA",
        baseUrl: GATE_SHIM_BASE_URL,
        enabledModels: [GATE_MODEL],
        isEnabled: true,
      },
    });
    await prisma.systemSetting.create({
      data: { key: "aiSurfaceConfig", value: AI_SURFACE_CONFIG_VALUE },
    });
    // ADDITIVE (Task 1.7): the system default low-stock threshold as a REAL setting
    // row. Its value is identical to `LOW_STOCK_DEFAULT_FALLBACK`, so no behaviour
    // changes — but the "override EQUALS the default" C8 case now rests on a value the
    // oracle can READ instead of on a constant the harness would have to assume.
    await prisma.systemSetting.create({
      data: {
        key: "lowStockDefaultThreshold",
        value: String(GATE_SEED.fixtures.lowStockDefaultThreshold),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
