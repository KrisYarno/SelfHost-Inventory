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
 */

import {
  InboundShipmentStatus,
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
 * Deletes the gate-owned ledger rows, exception rows and audit rows for the
 * scope; deletes every NON-SEED header and line (a scenario that creates its own
 * second order recreates it AFTER this call — pack C7b.2 scenario 5); then
 * restores the complete seed snapshot of every scoped line, the header, every
 * scoped product (approval / deletion / review / costPrice / quantity — a first
 * batch's D-COST fill moves costPrice) and the scoped `product_locations` rows.
 */
export async function resetGateFixtures(scope: GateScope): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: gateDatabaseUrl() } } });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.inventory_logs.deleteMany({
        where: {
          OR: [
            { stagingItemId: { in: [...scope.lineIds] } },
            { productId: { in: [...scope.productIds] } },
            // Rows a scenario-created line left behind. NULL stagingItemId never
            // matches a NOT IN and is left alone — this gate writes none.
            { stagingItemId: { notIn: [...SEED_LINE_IDS] } },
          ],
        },
      });
      await tx.inventoryException.deleteMany({ where: { key: { in: exceptionKeysFor(scope) } } });
      await tx.auditLog.deleteMany({
        where: {
          OR: [
            { entityType: "STAGING", entityId: { in: scope.lineIds.map(String) } },
            { entityType: "PRODUCT", entityId: { in: scope.productIds.map(String) } },
            { entityType: "SHIPMENT", entityId: { in: [...SEED_HEADER_IDS] } },
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
