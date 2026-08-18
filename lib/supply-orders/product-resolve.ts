import { Prisma, ProductApprovalStatus } from '@prisma/client';
import { AppError } from '@/lib/error-handling';
import { formatProductName } from '@/lib/products';
import type { ProductCreateFromOrderInput } from '@/lib/validation/supply-orders';

/**
 * THE ONE PRODUCT RESOLVER for the supply-order flow (contract pack C2c.2;
 * seam S10).
 *
 * Every place a line names a product — order entry, "add arrived line", and
 * verify's `deliveredProduct` re-map — asks this function, and it answers the
 * same way each time: an id, the name to snapshot onto the line, the approval
 * status, whether it had to create the row, and the location the product lives
 * at.
 *
 * TWO CONTRACTS, pulling in opposite directions on purpose:
 *
 *   1. THE APPROVAL GATE (spec §3). A line may point at an APPROVED product, or
 *      at a PENDING_REVIEW product THE ACTOR CREATED — nothing else. Admin
 *      status does NOT bypass the ownership half: an admin who wants to order
 *      against somebody else's unreviewed row APPROVES it first, which is a
 *      deliberate, audited act. The rule exists from the other side too: a
 *      non-admin re-ordering a product they created last week must not be
 *      forced to duplicate it (G2s-7).
 *
 *   2. THE CREATE MAPPING IS `POST /api/products`, EXACTLY (PK2-3). Re-homed
 *      HERE ONCE — the same normalization, the same duplicate predicate with
 *      the route's 400 (not a 409), the same location check, the same
 *      lowStockThreshold NULL rule, the same reorder-config branch. The
 *      `lib/staging/graduate.ts` copy of this mapping is what M6 deletes; a
 *      third copy would be the drift this consolidation exists to end.
 *      ONE DELIBERATE DIFFERENCE: `costPrice` is ALWAYS null. A product created
 *      while entering an order is priced by the RECEIPT (premise 1 / D10) and
 *      the order form does not collect a cost at all.
 *
 * TX-SCOPED: it takes the caller's `tx`, opens no transaction of its own and
 * retries nothing — the duplicate check and the create must commit or roll back
 * with the line that asked for them.
 */

/** What a line says about its product: point at one, or create one. */
export type SupplyOrderProductInput =
  | { mode: 'existing'; productId: number }
  | { mode: 'new'; productFields: ProductCreateFromOrderInput };

export type ResolvedSupplyOrderProduct = {
  productId: number;
  /** The name to snapshot into the line's `description` at this instant. */
  productName: string;
  approvalStatus: ProductApprovalStatus;
  /** True when this call inserted the product row (the caller audits it). */
  created: boolean;
  /** The product's own location column (the route's `location`). */
  locationId: number;
};

/** The house default location, exactly as `POST /api/products` applies it. */
const DEFAULT_LOCATION_ID = 1;

/**
 * Resolve the product a supply-order line points at.
 *
 * The caller records `PRODUCT_CREATE` (`entityType: 'PRODUCT'`, `entityId:
 * productId`) under ITS batchId when `created` — the audit belongs to the act
 * that asked for the product, not to this helper.
 */
export async function resolveSupplyOrderProduct(
  tx: Prisma.TransactionClient,
  input: SupplyOrderProductInput,
  actor: { id: number; isAdmin: boolean },
): Promise<ResolvedSupplyOrderProduct> {
  if (input.mode === 'existing') {
    return selectExisting(tx, input.productId, actor);
  }
  return createNew(tx, input.productFields, actor);
}

/**
 * The SELECT half. A plain read, deliberately: naming a product is not a
 * counter and nothing here decides against a value another transaction could be
 * moving — the booking primitive is where the product row is locked.
 */
async function selectExisting(
  tx: Prisma.TransactionClient,
  productId: number,
  actor: { id: number; isAdmin: boolean },
): Promise<ResolvedSupplyOrderProduct> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      approvalStatus: true,
      deletedAt: true,
      createdBy: true,
      location: true,
    },
  });

  if (!product || product.deletedAt !== null) {
    throw new AppError('Target product not found', 'BAD_REQUEST', 400);
  }

  const selectable =
    product.approvalStatus === ProductApprovalStatus.APPROVED ||
    (product.approvalStatus === ProductApprovalStatus.PENDING_REVIEW &&
      product.createdBy === actor.id);

  if (!selectable) {
    // Deliberately the SAME answer for an admin: ownership is not an admin
    // permission, it is a statement about who vouched for the row.
    throw new AppError(
      `Product ${productId} is pending approval — approve it, or pick a product you created yourself`,
      'BAD_REQUEST',
      400,
    );
  }

  return {
    productId: product.id,
    productName: product.name,
    approvalStatus: product.approvalStatus,
    created: false,
    locationId: product.location,
  };
}

/**
 * The CREATE half — `POST /api/products`'s mapping, verbatim except for the
 * cost. Read it beside `app/api/products/route.ts`: every line here has a
 * counterpart there, and the byte-equal payload pin in the unit suite is what
 * keeps it that way.
 */
async function createNew(
  tx: Prisma.TransactionClient,
  fields: ProductCreateFromOrderInput,
  actor: { id: number; isAdmin: boolean },
): Promise<ResolvedSupplyOrderProduct> {
  const baseName = fields.baseName.trim();
  const variant = fields.variant.trim();
  const unit = fields.unit ? fields.unit.trim().toLowerCase() : null;
  const numericValue = fields.numericValue ?? null;
  const productName = formatProductName({ baseName, variant });

  // The route's predicate, transaction-local: a duplicate is a 400 with the
  // route's own words (NOT a 409 — the client is being told its payload names a
  // product that already exists, not that it lost a race).
  const duplicate = await tx.product.findFirst({
    where: { baseName, variant, deletedAt: null },
  });
  if (duplicate) {
    throw new AppError(
      'Product with this base name and variant already exists',
      'BAD_REQUEST',
      400,
    );
  }

  const locationId = fields.locationId || DEFAULT_LOCATION_ID;
  const location = await tx.location.findUnique({ where: { id: locationId } });
  if (!location) {
    throw new AppError('Location not found', 'BAD_REQUEST', 400);
  }

  const created = await tx.product.create({
    data: {
      name: productName,
      baseName,
      variant,
      unit,
      numericValue,
      quantity: 0,
      location: locationId,
      // NULL = inherit the system default (R-L13), never a materialized 10.
      lowStockThreshold: fields.lowStockThreshold === undefined ? null : fields.lowStockThreshold,
      // ALWAYS NULL (premise 1 / D10): the receipt's own unit cost prices this
      // product through the D-COST prompt. The order form never collects one,
      // and the schema refuses a payload that carries the field at all.
      costPrice: null,
      retailPrice: fields.retailPrice ?? null,
      approvalStatus: actor.isAdmin
        ? ProductApprovalStatus.APPROVED
        : ProductApprovalStatus.PENDING_REVIEW,
      createdBy: actor.id,
    },
  });

  // Per-product reorder config, written ONLY when the client actually sent
  // config fields — otherwise the product inherits every global default (no row
  // = inherit-all), exactly as the route decides it.
  const rc = fields.reorderConfig;
  const hasConfig = rc && Object.values(rc).some((v) => v !== undefined);
  if (hasConfig) {
    await tx.productReorderConfig.create({
      data: {
        productId: created.id,
        leadTimeDays: rc!.leadTimeDays ?? null,
        customSafetyStockDays: rc!.customSafetyStockDays ?? null,
        minOrderQuantity: rc!.minOrderQuantity ?? 1,
        reorderPointOverride: rc!.reorderPointOverride ?? null,
      },
    });
  }

  return {
    productId: created.id,
    productName,
    approvalStatus: created.approvalStatus,
    created: true,
    locationId,
  };
}
