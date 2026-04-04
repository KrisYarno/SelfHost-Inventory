import { NextRequest, NextResponse } from "next/server";
import { requireApproved, requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { isProductUnique, formatProductName } from "@/lib/products";
import { getCurrentQuantity } from "@/lib/inventory";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
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

// PUT /api/products/[id] - Update product (Admin only)
export const PUT = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, "products:PUT", {
    identifier: user.id,
  });

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
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

  if (body.lowStockThreshold !== undefined) {
    updateData.lowStockThreshold = Math.max(0, body.lowStockThreshold);
  }

  if (body.costPrice !== undefined) {
    const sanitizedCost = Number(body.costPrice);
    updateData.costPrice = sanitizedCost >= 0 ? sanitizedCost : 0;
  }

  if (body.retailPrice !== undefined) {
    const sanitizedRetail = Number(body.retailPrice);
    updateData.retailPrice = sanitizedRetail >= 0 ? sanitizedRetail : 0;
  }

  const product = await prisma.product.update({
    where: { id: productId },
    data: updateData,
  });

  const changes: Record<string, any> = {};
  if (body.baseName !== undefined && body.baseName !== existingProduct.baseName) {
    changes.baseName = { from: existingProduct.baseName, to: body.baseName };
  }
  if (body.variant !== undefined && body.variant !== existingProduct.variant) {
    changes.variant = { from: existingProduct.variant, to: body.variant };
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

  await auditService.logProductUpdate(user.id, product.id, product.name, changes);

  const response = NextResponse.json(product);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});

// DELETE /api/products/[id] - Soft delete product (Admin only)
export const DELETE = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, "products:DELETE", {
    identifier: user.id,
  });

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

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

  const product = await prisma.product.update({
    where: { id: productId },
    data: {
      deletedAt: new Date(),
      deletedBy: user.id,
    },
  });

  await auditService.logProductDelete(user.id, product.id, product.name);

  const response = NextResponse.json({
    message: "Product deleted successfully",
    product,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
