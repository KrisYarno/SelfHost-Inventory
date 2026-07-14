import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { ProductFilters } from "@/types/product";
import { getProductsWithQuantities, isProductUnique, formatProductName } from "@/lib/products";
import { recordChange } from "@/lib/change-tracking";
import { ProductCreateUISchema } from "@/lib/validation/product";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// GET /api/products - List all products with filters
export const GET = apiHandler(async (request: NextRequest) => {
  const { user: _user } = await requireApproved();

  const searchParams = request.nextUrl.searchParams;

  const requestedSort = searchParams.get("sortBy") as ProductFilters["sortBy"] | null;
  const allowedSorts: ProductFilters["sortBy"][] = [
    "name",
    "baseName",
    "numericValue",
    "baseNameNumeric",
  ];
  const sortBy =
    requestedSort && allowedSorts.includes(requestedSort) ? requestedSort : "baseNameNumeric";

  const filters: ProductFilters = {
    search: searchParams.get("search") || undefined,
    sortBy,
    sortOrder: (searchParams.get("sortOrder") as ProductFilters["sortOrder"]) || "asc",
    page: parseInt(searchParams.get("page") || "1"),
    pageSize: parseInt(searchParams.get("pageSize") || "25"),
  };

  const locationId = searchParams.get("locationId");
  const getTotal = searchParams.get("getTotal") === "true" || !locationId;

  const { products, total } = await getProductsWithQuantities(
    filters,
    locationId ? parseInt(locationId) : undefined,
    getTotal
  );

  return NextResponse.json({
    products,
    total,
    page: filters.page,
    pageSize: filters.pageSize,
  });
});

// POST /api/products - Create new product.
// Approved users may create; non-admin creations are provisional (PENDING_REVIEW)
// until an admin approves them. Admin creations are auto-approved.
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "products:POST", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = ProductCreateUISchema.parse(await request.json());

  const baseName = body.baseName.trim();
  const variant = body.variant.trim();
  const unit = body.unit ? body.unit.trim().toLowerCase() : null;
  const numericValue = body.numericValue ?? null;
  const name = formatProductName({ baseName, variant });

  if (baseName && variant) {
    const isUnique = await isProductUnique(baseName, variant);
    if (!isUnique) {
      return NextResponse.json(
        { error: "Product with this base name and variant already exists" },
        { status: 400 }
      );
    }
  }

  const locationId = body.locationId || 1;

  const location = await prisma.location.findUnique({
    where: { id: locationId },
  });

  if (!location) {
    return NextResponse.json({ error: "Invalid location ID" }, { status: 400 });
  }

  // Lane 6 (R-D3): preserve NULL = "cost unknown". A blank field arrives as
  // null/undefined and is stored NULL (never coerced to 0); an explicit human 0
  // means genuinely free and is kept. A negative value is clamped away to null.
  const costPrice =
    body.costPrice === undefined || body.costPrice === null
      ? null
      : body.costPrice >= 0
        ? body.costPrice
        : null;
  const retailPrice = Number(body.retailPrice ?? 0);

  // Create + record atomically: the audit row is written in the SAME transaction
  // as the product insert, so an unrecordable create never commits (spec D4).
  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        name,
        baseName,
        variant,
        unit,
        numericValue,
        quantity: 0,
        location: locationId,
        // NULL = inherit the system default (R-L13); stop materializing 10 so the
        // configurable default actually governs newly created products. An omitted
        // field writes NULL explicitly (no low-stock predicate here — this route
        // resolves nothing against the threshold, so it needs no shared helper).
        lowStockThreshold: body.lowStockThreshold === undefined ? null : body.lowStockThreshold,
        costPrice,
        retailPrice: retailPrice >= 0 ? retailPrice : 0,
        approvalStatus: user.isAdmin ? "APPROVED" : "PENDING_REVIEW",
        createdBy: user.id,
      },
    });

    // Per-product reorder config (Lane reorder-points). Only written when the client
    // actually sent config fields — otherwise the product inherits every global
    // default (no row = inherit-all).
    const rc = body.reorderConfig;
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

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "PRODUCT_CREATE",
      entityType: "PRODUCT",
      entityId: created.id,
      action: `Created product "${created.name}"`,
      details: { productName: created.name, ...(hasConfig ? { reorderConfig: rc } : {}) },
    });

    return created;
  });

  const response = NextResponse.json(product, { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
