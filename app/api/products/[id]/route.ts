import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ZodError } from "zod";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getCurrentQuantity, isProductUnique, formatProductName } from "@/lib/products";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
import { ProductUpdateSchema } from "@/lib/validation/product";
import { enforceRateLimit, RateLimitError, applyRateLimitHeaders } from "@/lib/rateLimit";

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// GET /api/products/[id] - Get single product
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    const product = await prisma.product.findFirst({
      where: { 
        id: productId,
        deletedAt: null,
      },
      include: {
        inventory_logs: {
          include: {
            users: {
              select: {
                id: true,
                username: true,
              },
            },
            locations: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { changeTime: "desc" },
          take: 50, // Limit to recent logs
        },
      },
    });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // Get current quantity for the first location
    const location = await prisma.location.findFirst({
      where: { id: 1 },
    });

    const currentQuantity = location 
      ? await getCurrentQuantity(product.id, location.id)
      : 0;

    return NextResponse.json({
      ...product,
      currentQuantity,
    });
  } catch (error) {
    console.error("Error fetching product:", error);
    return NextResponse.json(
      { error: "Failed to fetch product" },
      { status: 500 }
    );
  }
}

// PUT /api/products/[id] - Update product (Admin only)
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    
    // Check if user is authenticated and is an admin
    if (!session?.user?.isApproved || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, "products:PUT", {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    const body = ProductUpdateSchema.parse(await request.json());

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // If updating baseName or variant, check uniqueness
    if (body.baseName !== undefined || body.variant !== undefined) {
      const newBaseName = body.baseName ?? existingProduct.baseName;
      const newVariant = body.variant ?? existingProduct.variant;
      
      const isUnique = await isProductUnique(newBaseName || '', newVariant || '', productId);
      if (!isUnique) {
        return NextResponse.json(
          { error: "Product with this base name and variant already exists" },
          { status: 400 }
        );
      }
    }

    // Build update data
    const updateData: any = {};
    
    if (body.baseName !== undefined) {
      updateData.baseName = body.baseName.trim();
    }
    
    if (body.variant !== undefined) {
      updateData.variant = body.variant.trim();
    }
    
    // Update name if baseName or variant changed
    if (body.baseName !== undefined || body.variant !== undefined) {
      updateData.name = formatProductName({
        baseName: updateData.baseName ?? existingProduct.baseName,
        variant: updateData.variant ?? existingProduct.variant,
      });
    }
    
    // Update numeric fields if provided
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

    // Update the product
    const product = await prisma.product.update({
      where: { id: productId },
      data: updateData,
    });

    // Log the product update with changes
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

    await auditService.logProductUpdate(
      parseInt(session.user.id),
      product.id,
      product.name,
      changes
    );

    const response = NextResponse.json(product);
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: "Invalid request payload",
          details: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    console.error("Error updating product:", error);
    return NextResponse.json(
      { error: "Failed to update product" },
      { status: 500 }
    );
  }
}

// DELETE /api/products/[id] - Soft delete product (Admin only)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    
    // Check if user is authenticated and is an admin
    if (!session?.user?.isApproved || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, "products:DELETE", {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    // Check if product exists and is not already deleted
    const existingProduct = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    if (existingProduct.deletedAt) {
      return NextResponse.json({ error: "Product is already deleted" }, { status: 400 });
    }

    // Soft delete the product
    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        deletedAt: new Date(),
        deletedBy: parseInt(session.user.id),
      },
    });

    // Log the product deletion
    await auditService.logProductDelete(
      parseInt(session.user.id),
      product.id,
      product.name
    );

    // Note: We don't create an inventory log for deletion as it's not an inventory change
    // The soft delete fields (deletedAt, deletedBy) serve as the audit trail

    const response = NextResponse.json({
      message: "Product deleted successfully",
      product,
    });
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }

    console.error("Error deleting product:", error);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 }
    );
  }
}
