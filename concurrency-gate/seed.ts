/**
 * concurrency-gate/seed.ts — the fixture the scenarios race on, and the reset
 * that puts it back (plan P-2; pack C7a.1).
 *
 * STABLE EXPLICIT IDS, exported as constants: a scenario names `LINE_L1`, never
 * a number it looked up, and the oracles query the same constant. Ids are far
 * away from 1..100 so a value that leaked from somewhere else is obvious.
 *
 * Written through a DEDICATED `PrismaClient` (pack C7a.1), disconnected after.
 * `mysql2/promise` is present as a devDependency but is RESERVED for the
 * oracles: the whole value of an oracle is that it does not share a code path
 * with the thing under test.
 *
 * THE FIXTURE (one supply order, three verified lines):
 *   L1  ordered 10, total 10001c, verified 10, P_APPROVED   — the 10001/3
 *       exactness family: shares of 7 and 3 are 7000 and 3001, summing exactly.
 *   L2  ordered 6, verified 6, NO total, P_PENDING          — the unpriced line
 *       (every STOCK_IN share is NULL) and the approval-race product.
 *   L3  UNORDERED (orderedQuantity NULL), verified 5, total 500, P_APPROVED_2
 *       — the basis-freeze family.
 *
 * THE RECONCILIATION FIXTURE (pack C6.1) sits BESIDE that, never inside it: two
 * DEDICATED products, their own ledger rows, an integration and two external
 * orders. It is seeded once and OUTLIVES every reset, because scenario 8 races
 * the same batch id over and over and a fixture the reset deleted would have to
 * be rebuilt between sub-cases. See the block below `SEED_HEADER_IDS`.
 */

import {
  InboundShipmentStatus,
  inventory_logs_logType,
  PrismaClient,
  ProductApprovalStatus,
  StagingItemStatus,
} from "@prisma/client";
import { assertGateDatabaseUrl, gateDatabaseUrl } from "./state";

// --------------------------------------------------------------------------
// The manifest
// --------------------------------------------------------------------------

export const GATE_COMPANY_ID = "concurrencygatecompany";
export const GATE_ADMIN_ID = 9001;
export const GATE_MEMBER_ID = 9002;

/** Location 1 is the COMPATIBILITY location (`products.quantity` mirrors it and
 *  nothing else); location 2 exists so a batch can land off-mirror. */
export const LOCATION_MAIN = 1;
export const LOCATION_SECOND = 2;

export const P_APPROVED = 9101;
export const P_PENDING = 9102;
export const P_APPROVED_2 = 9103;

export const GATE_ORDER_ID = "concurrencygateorder01";

export const LINE_L1 = 9201;
export const LINE_L2 = 9202;
export const LINE_L3 = 9203;

export const SEED_LINE_IDS: readonly number[] = [LINE_L1, LINE_L2, LINE_L3];
export const SEED_PRODUCT_IDS: readonly number[] = [P_APPROVED, P_PENDING, P_APPROVED_2];
export const SEED_HEADER_IDS: readonly string[] = [GATE_ORDER_ID];

// --------------------------------------------------------------------------
// The reconciliation fixture (pack C6.1) — scenarios 8 and 8b
// --------------------------------------------------------------------------

export const GATE_INTEGRATION_ID = "concurrencygateinteg01";
export const GATE_EXT_ORDER_ID = "concurrencygateext001";
export const GATE_EXT_ORDER_2_ID = "concurrencygateext002";

/**
 * DEDICATED products, deliberately OUTSIDE `SEED_PRODUCT_IDS`.
 *
 * The reconciliation family carries −1 SALE rows and a +2 adjust that never
 * moved `product_locations`, which is a perfectly good fixture for a report
 * about batch IDENTITY and a fatal one for `productOracle` (it asserts on-hand
 * == the sum of every ledger delta for the product, true only from this gate's
 * zero baseline). Keeping these ids out of the seed list is what guarantees the
 * three oracle-covered products never meet a foreign row.
 */
export const P_RECON_A = 9104;
export const P_RECON_B = 9105;

/** The batch scenario 8 races for: a LIVE deduct of one unit of each product. */
export const RECON_BATCH_ID = "concurrency-gate-recon-batch-01";

/** The 8b parity family's other batches — one per excluded/included class, so
 *  that a renderer which lost a conjunct shows up as a MEMBERSHIP difference in
 *  the distinct-batchId set rather than as nothing at all. */
export const RECON_ADJUST_BATCH_ID = "concurrency-gate-recon-adjust-1";
export const RECON_STOCK_IN_BATCH_ID = "concurrency-gate-recon-stockin";
export const RECON_COUNT_BATCH_ID = "concurrency-gate-recon-count-01";
export const RECON_POSITIVE_BATCH_ID = "concurrency-gate-recon-posadj-1";

/**
 * EVERY reconciliation/parity ledger row, by explicit id (pack C6.1). The reset
 * EXCLUDES these ids from its deletion and re-stamps them instead — see
 * `resetGateFixtures`.
 */
export const RECON_SALE_A_ID = 9301;
export const RECON_SALE_B_ID = 9302;
export const RECON_ADJUST_ID = 9303;
export const RECON_STOCK_IN_ID = 9304;
export const RECON_COUNT_ID = 9305;
export const RECON_POSITIVE_ID = 9306;
export const RECON_UNBATCHED_SALE_ID = 9307;

export const RECON_LEDGER_IDS: readonly number[] = [
  RECON_SALE_A_ID,
  RECON_SALE_B_ID,
  RECON_ADJUST_ID,
  RECON_STOCK_IN_ID,
  RECON_COUNT_ID,
  RECON_POSITIVE_ID,
  RECON_UNBATCHED_SALE_ID,
];

/** L1's line total. 10001 over a basis of 10 is deliberately indivisible: the
 *  money oracle is only worth running on a line whose shares cannot all be
 *  equal. */
export const L1_TOTAL_CENTS = 10001;
export const L3_TOTAL_CENTS = 500;

const ORDERED_AT = new Date("2026-08-01T09:00:00.000Z");
const VERIFIED_AT = new Date("2026-08-02T09:00:00.000Z");

/** The header, restored verbatim by every reset. */
const SEED_HEADER = {
  id: GATE_ORDER_ID,
  supplier: "Gate Supplier",
  supplierRef: "GATE-REF-1",
  status: InboundShipmentStatus.RECEIVING,
  orderedAt: ORDERED_AT,
  createdBy: GATE_ADMIN_ID,
  closedBy: null,
  closedAt: null,
  feesCents: 0,
  feesNote: null,
  notes: null,
};

type SeedLine = {
  id: number;
  description: string;
  status: StagingItemStatus;
  shipmentId: string;
  orderedProductId: number | null;
  resolvedProductId: number | null;
  orderedQuantity: number | null;
  lineTotalCents: number | null;
  verifiedQuantity: number | null;
  verifiedBy: number | null;
  verifiedAt: Date | null;
  labelingRequired: boolean;
  stockedQuantity: number;
  disposedQuantity: number;
  locationId: number | null;
  receivedBy: number | null;
  receivedAt: Date | null;
  graduatedBy: number | null;
  graduatedAt: Date | null;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  countedBy: number | null;
  countedAt: Date | null;
  unitCostCents: number | null;
  vendor: string | null;
  reference: string | null;
  notes: string | null;
};

function line(overrides: Partial<SeedLine> & Pick<SeedLine, "id" | "description">): SeedLine {
  return {
    status: StagingItemStatus.VERIFIED,
    shipmentId: GATE_ORDER_ID,
    orderedProductId: null,
    resolvedProductId: null,
    orderedQuantity: null,
    lineTotalCents: null,
    verifiedQuantity: null,
    verifiedBy: GATE_ADMIN_ID,
    verifiedAt: VERIFIED_AT,
    labelingRequired: true,
    stockedQuantity: 0,
    disposedQuantity: 0,
    locationId: null,
    receivedBy: null,
    receivedAt: null,
    graduatedBy: null,
    graduatedAt: null,
    expectedQuantity: null,
    countedQuantity: null,
    countedBy: null,
    countedAt: null,
    unitCostCents: null,
    vendor: null,
    reference: null,
    notes: null,
    ...overrides,
  };
}

/** THE snapshot. `resetGateFixtures` restores every column of it, so a scenario
 *  can never inherit a counter, a status or a location another scenario wrote. */
const SEED_LINES: Record<number, SeedLine> = {
  [LINE_L1]: line({
    id: LINE_L1,
    description: "Gate line L1 (ordered 10, priced)",
    orderedProductId: P_APPROVED,
    resolvedProductId: P_APPROVED,
    orderedQuantity: 10,
    lineTotalCents: L1_TOTAL_CENTS,
    verifiedQuantity: 10,
    labelingRequired: true,
  }),
  [LINE_L2]: line({
    id: LINE_L2,
    description: "Gate line L2 (ordered 6, unpriced, pending product)",
    orderedProductId: P_PENDING,
    resolvedProductId: P_PENDING,
    orderedQuantity: 6,
    lineTotalCents: null,
    verifiedQuantity: 6,
    labelingRequired: true,
  }),
  [LINE_L3]: line({
    id: LINE_L3,
    description: "Gate line L3 (unordered arrival, priced)",
    orderedProductId: null,
    resolvedProductId: P_APPROVED_2,
    orderedQuantity: null,
    lineTotalCents: L3_TOTAL_CENTS,
    verifiedQuantity: 5,
    labelingRequired: true,
  }),
};

type SeedProduct = {
  id: number;
  name: string;
  approvalStatus: ProductApprovalStatus;
  createdBy: number;
};

/** Every gate product starts at a ZERO baseline with a NULL costPrice: the
 *  product oracle's ledger-sum check is only true from zero, and a null cost is
 *  what makes the first batch's D-COST fill real. */
const SEED_PRODUCTS: Record<number, SeedProduct> = {
  [P_APPROVED]: {
    id: P_APPROVED,
    name: "Gate Product Approved",
    approvalStatus: ProductApprovalStatus.APPROVED,
    createdBy: GATE_ADMIN_ID,
  },
  [P_PENDING]: {
    id: P_PENDING,
    name: "Gate Product Pending",
    approvalStatus: ProductApprovalStatus.PENDING_REVIEW,
    createdBy: GATE_MEMBER_ID,
  },
  [P_APPROVED_2]: {
    id: P_APPROVED_2,
    name: "Gate Product Approved Two",
    approvalStatus: ProductApprovalStatus.APPROVED,
    createdBy: GATE_ADMIN_ID,
  },
};

function productRestoreData(product: SeedProduct) {
  return {
    name: product.name,
    quantity: 0,
    location: LOCATION_MAIN,
    costPrice: null,
    retailPrice: null,
    lowStockThreshold: null,
    approvalStatus: product.approvalStatus,
    createdBy: product.createdBy,
    reviewedBy: null,
    reviewedAt: null,
    deletedAt: null,
    deletedBy: null,
  };
}

function seedLocationRows(productIds: readonly number[]) {
  return productIds.flatMap((productId) =>
    [LOCATION_MAIN, LOCATION_SECOND].map((locationId) => ({
      productId,
      locationId,
      quantity: 0,
      minQuantity: 0,
      version: 0,
    })),
  );
}

// --------------------------------------------------------------------------
// The reconciliation fixture's rows (pack C6.1)
// --------------------------------------------------------------------------

/** APPROVED, like a product a real sale would deduct from. One location row
 *  each (C6.1) — nothing here reads their on-hand, and a second row would only
 *  invite a future oracle to. */
const RECON_PRODUCTS: readonly SeedProduct[] = [
  {
    id: P_RECON_A,
    name: "Gate Product Recon A",
    approvalStatus: ProductApprovalStatus.APPROVED,
    createdBy: GATE_ADMIN_ID,
  },
  {
    id: P_RECON_B,
    name: "Gate Product Recon B",
    approvalStatus: ProductApprovalStatus.APPROVED,
    createdBy: GATE_ADMIN_ID,
  },
];

const RECON_AT = new Date("2026-08-05T09:00:00.000Z");

type ReconLedgerRow = {
  id: number;
  productId: number;
  delta: number;
  logType: inventory_logs_logType;
  batchId: string | null;
};

/**
 * THE SIX-CLASS PARITY FAMILY, frozen (pack C6.1). Two of these classes are IN
 * the attributable population and four are out — one per conjunct of the
 * predicate, so scenario 8b's two renderers disagree the moment either drops a
 * clause:
 *
 *   SALE −1 with a batch          IN  (and the batch scenario 8 races for)
 *   ADJUSTMENT −2 with a batch    IN
 *   STOCK_IN −1 with a batch      out — the logType conjunct, and ONLY that one
 *   COUNT −1 with a batch         out — the logType conjunct
 *   ADJUSTMENT +2 with a batch    out — the delta conjunct
 *   SALE −1 with NULL batchId     out — the batchId conjunct
 *
 * The STOCK_IN and COUNT rows carry a NEGATIVE delta on purpose: a positive one
 * would be excluded twice over and would prove nothing about `logType IN (...)`.
 * A wrong-signed STOCK_IN is a shape this ledger really holds (the M5b receipts
 * roll-up filters `delta > 0` for exactly that reason), so the fixture is odd,
 * not fictional.
 */
const RECON_LEDGER_ROWS: readonly ReconLedgerRow[] = [
  {
    id: RECON_SALE_A_ID,
    productId: P_RECON_A,
    delta: -1,
    logType: inventory_logs_logType.SALE,
    batchId: RECON_BATCH_ID,
  },
  {
    id: RECON_SALE_B_ID,
    productId: P_RECON_B,
    delta: -1,
    logType: inventory_logs_logType.SALE,
    batchId: RECON_BATCH_ID,
  },
  {
    id: RECON_ADJUST_ID,
    productId: P_RECON_A,
    delta: -2,
    logType: inventory_logs_logType.ADJUSTMENT,
    batchId: RECON_ADJUST_BATCH_ID,
  },
  {
    id: RECON_STOCK_IN_ID,
    productId: P_RECON_A,
    delta: -1,
    logType: inventory_logs_logType.STOCK_IN,
    batchId: RECON_STOCK_IN_BATCH_ID,
  },
  {
    id: RECON_COUNT_ID,
    productId: P_RECON_B,
    delta: -1,
    logType: inventory_logs_logType.COUNT,
    batchId: RECON_COUNT_BATCH_ID,
  },
  {
    id: RECON_POSITIVE_ID,
    productId: P_RECON_B,
    delta: 2,
    logType: inventory_logs_logType.ADJUSTMENT,
    batchId: RECON_POSITIVE_BATCH_ID,
  },
  {
    id: RECON_UNBATCHED_SALE_ID,
    productId: P_RECON_A,
    delta: -1,
    logType: inventory_logs_logType.SALE,
    batchId: null,
  },
];

function reconLedgerData(row: ReconLedgerRow) {
  return {
    id: row.id,
    userId: GATE_ADMIN_ID,
    productId: row.productId,
    delta: row.delta,
    changeTime: RECON_AT,
    locationId: LOCATION_MAIN,
    logType: row.logType,
    // UNSTAMPED at seed time, and put back that way by every reset: an
    // attribution is what the scenarios are here to write.
    orderRecordId: null,
    batchId: row.batchId,
  };
}

/** Both external orders, identical but for identity. NO customer fields: this
 *  fixture is seeded by a lane whose whole discipline is that order PII never
 *  reaches a reconciliation surface, and a fixture that carries none can never
 *  be the thing that leaks one. */
function reconOrderData(id: string, externalId: string, orderNumber: string) {
  return {
    id,
    companyId: GATE_COMPANY_ID,
    integrationId: GATE_INTEGRATION_ID,
    externalId,
    orderNumber,
    nativeStatus: "processing",
    total: 0,
    rawPayload: {},
  };
}

/**
 * The batch's own audit event — the LIVE-DEDUCT shape (`details.updates`), which
 * is what makes R0 a real question rather than a vacuous one: a batch carrying
 * an `INVENTORY_BULK_UPDATE` summary AND a SALE row is attributable, and the
 * route's step-2 `isAttributableBatch` has to say so.
 *
 * INSTALLED AND REMOVED BY THE SUITE THAT NEEDS IT, not by `seedGateDatabase` —
 * `concurrency.test.ts` scenario 2 pins an ABSOLUTE, table-wide
 * `auditLog.count()` of 1, so a permanently seeded audit row would fail a
 * scenario that has nothing to do with this lane. (Deviation from C6.1, which
 * puts the row in the seed; reported with the milestone.) Every reset leaves it
 * alone: the reset only ever deletes `INVENTORY_ATTRIBUTE` rows for this batch.
 */
export async function installReconAuditEvent(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: gateDatabaseUrl() } } });
  try {
    await prisma.auditLog.create({
      data: {
        userId: GATE_ADMIN_ID,
        actionType: "INVENTORY_BULK_UPDATE",
        entityType: "INVENTORY",
        entityId: null,
        batchId: RECON_BATCH_ID,
        action: "Bulk updated inventory for 2 products",
        details: {
          updates: [
            { productId: P_RECON_A, productName: "Gate Product Recon A", delta: -1 },
            { productId: P_RECON_B, productName: "Gate Product Recon B", delta: -1 },
          ],
          locationId: LOCATION_MAIN,
        },
        affectedCount: 2,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** The other half of the bracket: the table-wide audit count goes back to what
 *  the seed left, whatever order jest ran the gate's files in. */
export async function removeReconAuditEvent(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: gateDatabaseUrl() } } });
  try {
    await prisma.auditLog.deleteMany({
      where: { actionType: "INVENTORY_BULK_UPDATE", batchId: RECON_BATCH_ID },
    });
  } finally {
    await prisma.$disconnect();
  }
}

// --------------------------------------------------------------------------
// Seeding
// --------------------------------------------------------------------------

export async function seedGateDatabase(databaseUrl: string): Promise<void> {
  assertGateDatabaseUrl(databaseUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    // Locations first: users.defaultLocationId FKs into this table.
    await prisma.location.createMany({
      data: [
        { id: LOCATION_MAIN, name: "Gate Main" },
        { id: LOCATION_SECOND, name: "Gate Overflow" },
      ],
    });

    // No passwordHash: this gate never authenticates. It drives the lib cores
    // in-process, so the actors exist only to satisfy the FKs and to be the
    // `userId` on the ledger and audit rows.
    await prisma.user.createMany({
      data: [
        {
          id: GATE_ADMIN_ID,
          username: "gateadmin",
          email: "gate-admin@concurrency.invalid",
          isAdmin: true,
          isApproved: true,
          defaultLocationId: LOCATION_MAIN,
        },
        {
          id: GATE_MEMBER_ID,
          username: "gatemember",
          email: "gate-member@concurrency.invalid",
          isAdmin: false,
          isApproved: true,
          defaultLocationId: LOCATION_MAIN,
        },
      ],
    });

    await prisma.company.createMany({
      data: [{ id: GATE_COMPANY_ID, name: "Gate Company", slug: "concurrency-gate-company" }],
    });
    await prisma.userCompany.createMany({
      data: [
        { userId: GATE_ADMIN_ID, companyId: GATE_COMPANY_ID },
        { userId: GATE_MEMBER_ID, companyId: GATE_COMPANY_ID },
      ],
    });

    await prisma.product.createMany({
      data: SEED_PRODUCT_IDS.map((id) => ({ id, ...productRestoreData(SEED_PRODUCTS[id]) })),
    });
    await prisma.product_locations.createMany({ data: seedLocationRows(SEED_PRODUCT_IDS) });

    await prisma.inboundShipment.create({ data: SEED_HEADER });
    await prisma.stagingItem.createMany({ data: SEED_LINE_IDS.map((id) => SEED_LINES[id]) });

    // THE RECONCILIATION FIXTURE (pack C6.1), last and separately: its products
    // are not in `SEED_PRODUCT_IDS`, so nothing above has touched them.
    await prisma.product.createMany({
      data: RECON_PRODUCTS.map((product) => ({ id: product.id, ...productRestoreData(product) })),
    });
    await prisma.product_locations.createMany({
      data: RECON_PRODUCTS.map((product) => ({
        productId: product.id,
        locationId: LOCATION_MAIN,
        quantity: 0,
        minQuantity: 0,
        version: 0,
      })),
    });

    // The store the manual attribution points AT. An integration and two orders:
    // scenario 8's two racers may name the same target (8.i) or different ones
    // (8.ii), and the follow-up overwrite moves a batch from the first to the
    // second.
    await prisma.integration.create({
      data: {
        id: GATE_INTEGRATION_ID,
        companyId: GATE_COMPANY_ID,
        platform: "WOOCOMMERCE",
        name: "Gate Store",
        storeUrl: "https://concurrency-gate.invalid",
      },
    });
    await prisma.externalOrder.createMany({
      data: [
        reconOrderData(GATE_EXT_ORDER_ID, "gate-ext-1", "1001"),
        reconOrderData(GATE_EXT_ORDER_2_ID, "gate-ext-2", "1002"),
      ],
    });

    await prisma.inventory_logs.createMany({ data: RECON_LEDGER_ROWS.map(reconLedgerData) });
  } finally {
    await prisma.$disconnect();
  }
}

// --------------------------------------------------------------------------
// Reset
// --------------------------------------------------------------------------

/**
 * What a scenario owns. Reset is SCOPED so a scenario states, in one place, the
 * lines and products it is about to move — and so M7b's cross-actor races can
 * scope a second header's lines without disturbing the rest of the fixture.
 */
export type GateScope = {
  lineIds: readonly number[];
  productIds: readonly number[];
};

const exceptionKeysFor = (scope: GateScope): string[] => [
  ...scope.lineIds.flatMap((id) => [
    `recv-discrepancy:${id}`,
    `labeling-loss:${id}`,
    `cost-differs:${id}`,
  ]),
  ...scope.productIds.map((id) => `pending-with-stock:${id}`),
];

/**
 * Put the scoped fixture back exactly as the seed left it, in ONE transaction.
 *
 * Deletes the gate-owned ledger rows, exception rows, attribution attempts and
 * audit rows for the scope; deletes every NON-SEED header and line (a scenario
 * that creates its own second order recreates it AFTER this call — pack C7b.2
 * scenario 5); then restores the complete seed snapshot of every scoped line,
 * the header, every scoped product (approval / deletion / review / costPrice /
 * quantity — a first batch's D-COST fill moves costPrice) and the scoped
 * `product_locations` rows.
 *
 * THE RECONCILIATION FIXTURE IS THE ONE EXCEPTION (pack C6.1). Its ledger rows
 * are excluded from the deletion by id and RE-STAMPED instead; its attempt rows
 * and its `INVENTORY_ATTRIBUTE` audit rows are deleted by batch. Everything
 * scenario 8 writes is undone; nothing it needs is rebuilt.
 */
export async function resetGateFixtures(scope: GateScope): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: gateDatabaseUrl() } } });
  try {
    await prisma.$transaction(async (tx) => {
      // ONE spelling of "the ledger rows this reset owns" — the derivation below
      // and the delete itself must ask exactly the same question (pack CB1b.7).
      const scopedLedgerWhere = {
        // THE RECONCILIATION FAMILY SURVIVES (pack C6.1). Its rows are the
        // fixture scenarios 8/8b race on, they are seeded once, and they are
        // put back by the re-stamp below rather than by a rebuild — a deletion
        // here would take the batch itself away between two sub-cases.
        id: { notIn: [...RECON_LEDGER_IDS] },
        OR: [
          { stagingItemId: { in: [...scope.lineIds] } },
          { productId: { in: [...scope.productIds] } },
          // Rows a scenario-created line left behind. NULL stagingItemId never
          // matches a NOT IN and is left alone — this gate writes none.
          { stagingItemId: { notIn: [...SEED_LINE_IDS] } },
        ],
      };

      // B1 OWNS THIS (reconciliation Part 2, pack CB1b.7). Scenario 13 drives
      // the REAL deduct-simple and batch-adjust routes, and every route mints
      // its own batchId, stamps it on the ledger rows AND files an
      // `INVENTORY_BULK_UPDATE` audit row and an attempt row under it. No
      // existing clause below names those ids — they are minted at run time —
      // so they used to survive the reset, and receiving scenario 2's ABSOLUTE
      // audit count is exactly the kind of assertion that residue breaks.
      //
      // The derivation reuses the delete's FULL where, `id: { notIn:
      // RECON_LEDGER_IDS }` included: taken over the scope alone it would pick
      // up RECON_BATCH_ID, and the reset would then eat the recon fixture's own
      // audit summary and attempt rows — the ones the clauses below go out of
      // their way to keep. It runs BEFORE the delete, because after it there is
      // nothing left to derive from.
      const routeBatchIds = (
        await tx.inventory_logs.findMany({
          where: { ...scopedLedgerWhere, batchId: { not: null } },
          select: { batchId: true },
          distinct: ["batchId"],
        })
      )
        .map((row) => row.batchId)
        .filter((batchId): batchId is string => batchId !== null);

      await tx.inventory_logs.deleteMany({ where: scopedLedgerWhere });
      // The ONE thing a scenario changes about those rows: put the stamp back.
      await tx.inventory_logs.updateMany({
        where: { id: { in: [...RECON_LEDGER_IDS] } },
        data: { orderRecordId: null },
      });
      await tx.inventoryException.deleteMany({ where: { key: { in: exceptionKeysFor(scope) } } });
      // Reconciliation lane (pack C1a.4 / C6.1): attempt rows are append-only in
      // app/ lib/ scripts/ — the static gate scans THOSE roots, and
      // `concurrency-gate/` is outside them, so a fixture reset may legally
      // delete them (the same licence covers the `updateMany` above). SCOPED to
      // the scenario's own batch now that the recon fixture exists: nothing else
      // in this gate writes an attempt row, and an unscoped delete would quietly
      // cover for one that did.
      // ...plus, per B1, the attempts the route-driven scenarios minted (the
      // fixture's own RECON_BATCH_ID attempts are still the other half).
      await tx.orderAttributionAttempt.deleteMany({
        where: { batchId: { in: [RECON_BATCH_ID, ...routeBatchIds] } },
      });
      await tx.auditLog.deleteMany({
        where: {
          OR: [
            { entityType: "STAGING", entityId: { in: scope.lineIds.map(String) } },
            { entityType: "PRODUCT", entityId: { in: scope.productIds.map(String) } },
            { entityType: "SHIPMENT", entityId: { in: [...SEED_HEADER_IDS] } },
            // The manual attribution's own event: `entityId` is the LEDGER batch
            // id and its own `batchId` is a freshly minted one, so BOTH halves of
            // this clause are needed — and neither of them matches the fixture's
            // INVENTORY_BULK_UPDATE summary, which stays put.
            { actionType: "INVENTORY_ATTRIBUTE", entityId: RECON_BATCH_ID },
            // B1 (pack CB1b.7): the INVENTORY events a route-driven scenario
            // filed under its own minted batchId — scoped by that id, so the
            // fixture's summary row (RECON_BATCH_ID, excluded above) is safe.
            { entityType: "INVENTORY", batchId: { in: routeBatchIds } },
          ],
        },
      });

      await tx.stagingItem.deleteMany({ where: { id: { notIn: [...SEED_LINE_IDS] } } });
      await tx.inboundShipment.deleteMany({ where: { id: { notIn: [...SEED_HEADER_IDS] } } });

      for (const lineId of scope.lineIds) {
        const snapshot = SEED_LINES[lineId];
        if (!snapshot) throw new Error(`resetGateFixtures: ${lineId} is not a seeded line`);
        await tx.stagingItem.upsert({
          where: { id: lineId },
          create: snapshot,
          update: snapshot,
        });
      }

      await tx.inboundShipment.upsert({
        where: { id: GATE_ORDER_ID },
        create: SEED_HEADER,
        update: SEED_HEADER,
      });

      for (const productId of scope.productIds) {
        const product = SEED_PRODUCTS[productId];
        if (!product) throw new Error(`resetGateFixtures: ${productId} is not a seeded product`);
        const data = productRestoreData(product);
        await tx.product.upsert({
          where: { id: productId },
          create: { id: productId, ...data },
          update: data,
        });
      }

      await tx.product_locations.deleteMany({ where: { productId: { in: [...scope.productIds] } } });
      await tx.product_locations.createMany({ data: seedLocationRows(scope.productIds) });
    });
  } finally {
    await prisma.$disconnect();
  }
}
