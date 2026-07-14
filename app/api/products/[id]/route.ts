import { NextRequest, NextResponse } from "next/server";
import { requireApproved, requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { isProductUnique, formatProductName } from "@/lib/products";
import { getCurrentQuantity } from "@/lib/inventory";
import { recordChange, type ChangeDiff } from "@/lib/change-tracking";
import { ProductUpdateSchema } from "@/lib/validation/product";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: {
    id: string;
  };
}

// GET /api/products/[id] - Get single product
export const GET = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  await requireApproved();

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    include: {
      inventory_logs: {
        include: {
          users: { select: { id: true, username: true } },
          locations: { select: { id: true, name: true } },
        },
        orderBy: { changeTime: "desc" },
        take: 50,
      },
    },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const location = await prisma.location.findFirst({ where: { id: 1 } });
  const currentQuantity = location ? await getCurrentQuantity(product.id, location.id) : 0;

  return NextResponse.json({
    ...product,
    currentQuantity,
  });
});

// PUT /api/products/[id] - Update product.
// Admins may edit any product. Non-admin approved users may edit only their own
// product while it is still PENDING_REVIEW (creator-edit-own-pending).
export const PUT = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "products:PUT", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  const target = await prisma.product.findUnique({
    where: { id: productId },
    select: { createdBy: true, approvalStatus: true, deletedAt: true },
  });
  const isOwnPending =
    target?.deletedAt === null &&
    target?.createdBy === user.id &&
    target?.approvalStatus === "PENDING_REVIEW";
  if (!user.isAdmin && !isOwnPending) {
    // S6: anti-enumeration 404 (not 403) — do not leak that the product exists.
    throw new AppError("Resource not found", "NOT_FOUND", 404);
  }

  const body = ProductUpdateSchema.parse(await request.json());

  const existingProduct = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!existingProduct) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  if (body.baseName !== undefined || body.variant !== undefined) {
    const newBaseName = body.baseName ?? existingProduct.baseName;
    const newVariant = body.variant ?? existingProduct.variant;

    const isUnique = await isProductUnique(newBaseName || "", newVariant || "", productId);
    if (!isUnique) {
      return NextResponse.json(
        { error: "Product with this base name and variant already exists" },
        { status: 400 }
      );
    }
  }

  const updateData: any = {};

  if (body.baseName !== undefined) updateData.baseName = body.baseName.trim();
  if (body.variant !== undefined) updateData.variant = body.variant.trim();

  if (body.baseName !== undefined || body.variant !== undefined) {
    updateData.name = formatProductName({
      baseName: updateData.baseName ?? existingProduct.baseName,
      variant: updateData.variant ?? existingProduct.variant,
    });
  }

  // Size fields are safe to pass through: formatProductName derives name from
  // baseName+variant only, so unit/numericValue never affect the derived name.
  if (body.unit !== undefined) updateData.unit = body.unit;
  if (body.numericValue !== undefined) updateData.numericValue = body.numericValue;

  // NULL = inherit the system default (R-L13); persisted distinctly from 0.
  // Only a real number is floored at 0 (the schema already enforces >= 0).
  if (body.lowStockThreshold !== undefined) {
    updateData.lowStockThreshold =
      body.lowStockThreshold === null ? null : Math.max(0, body.lowStockThreshold);
  }

  if (body.costPrice !== undefined) {
    const sanitizedCost = Number(body.costPrice);
    updateData.costPrice = sanitizedCost >= 0 ? sanitizedCost : 0;
  }

  if (body.retailPrice !== undefined) {
    const sanitizedRetail = Number(body.retailPrice);
    updateData.retailPrice = sanitizedRetail >= 0 ? sanitizedRetail : 0;
  }

  // Field-level diff already in {field:{from,to}} shape — flows straight through
  // as ChangeEvent.changes (recordChange nests it under details.changes, matching
  // the legacy logProductUpdate row while preserving the exact numeric coercions).
  const changes: ChangeDiff = {};
  if (body.baseName !== undefined && body.baseName !== existingProduct.baseName) {
    changes.baseName = { from: existingProduct.baseName, to: body.baseName };
  }
  if (body.variant !== undefined && body.variant !== existingProduct.variant) {
    changes.variant = { from: existingProduct.variant, to: body.variant };
  }
  if (body.unit !== undefined && body.unit !== existingProduct.unit) {
    changes.unit = { from: existingProduct.unit, to: body.unit };
  }
  if (
    body.numericValue !== undefined &&
    Number(body.numericValue) !== Number(existingProduct.numericValue)
  ) {
    changes.numericValue = {
      from: existingProduct.numericValue === null ? null : Number(existingProduct.numericValue),
      to: body.numericValue,
    };
  }
  if (body.lowStockThreshold !== undefined && body.lowStockThreshold !== existingProduct.lowStockThreshold) {
    changes.lowStockThreshold = { from: existingProduct.lowStockThreshold, to: body.lowStockThreshold };
  }
  if (body.costPrice !== undefined && Number(body.costPrice) !== Number(existingProduct.costPrice)) {
    changes.costPrice = { from: Number(existingProduct.costPrice), to: body.costPrice };
  }
  if (body.retailPrice !== undefined && Number(body.retailPrice) !== Number(existingProduct.retailPrice)) {
    changes.retailPrice = { from: Number(existingProduct.retailPrice), to: body.retailPrice };
  }

  // Update + record atomically (spec D4): fetch/parse/diff above stay outside the tx.
  const product = await prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id: productId },
      data: updateData,
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "PRODUCT_UPDATE",
      entityType: "PRODUCT",
      entityId: updated.id,
      action: `Updated product "${updated.name}"`,
      changes,
      details: { productName: updated.name },
    });

    return updated;
  });

  const response = NextResponse.json(product);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});

// DELETE /api/products/[id] - Soft delete product (Admin only)
export const DELETE = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, "products:DELETE", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  const existingProduct = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!existingProduct) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  if (existingProduct.deletedAt) {
    return NextResponse.json({ error: "Product is already deleted" }, { status: 400 });
  }

  const product = await prisma.$transaction(async (tx) => {
    // D8: snapshot the stock held at delete time (nonzero rows only). No physical
    // movement occurs — a soft-deleted product's stock silently leaves
    // current-state views, so the event documents exactly what was held and when
    // it left view. Read inside the tx so the snapshot is consistent with the flip.
    const heldStock = await tx.product_locations.findMany({
      where: { productId, quantity: { not: 0 } },
      select: { locationId: true, quantity: true },
    });

    const deletedAt = new Date();
    const deleted = await tx.product.update({
      where: { id: productId },
      data: {
        deletedAt,
        deletedBy: user.id,
      },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "PRODUCT_DELETE",
      entityType: "PRODUCT",
      entityId: deleted.id,
      action: `Deleted product "${deleted.name}"`,
      changes: { deletedAt: { from: null, to: deletedAt.toISOString() } },
      details: { productName: deleted.name, heldStock },
    });

    return deleted;
  });

  const response = NextResponse.json({
    message: "Product deleted successfully",
    product,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
