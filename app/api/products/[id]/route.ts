import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { UpdateProductRequest } from "@/types/product";
import { getCurrentQuantity, isProductUnique, formatProductName } from "@/lib/products";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";

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

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    const body: UpdateProductRequest = await request.json();

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
    
    // Update lowStockThreshold if provided
    if (body.lowStockThreshold !== undefined) {
      updateData.lowStockThreshold = Math.max(0, body.lowStockThreshold);
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

    await auditService.logProductUpdate(
      parseInt(session.user.id),
      product.id,
      product.name,
      changes
    );

    return NextResponse.json(product);
  } catch (error) {
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

    return NextResponse.json({
      message: "Product deleted successfully",
      product,
    });
  } catch (error) {
    console.error("Error deleting product:", error);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 }
    );
  }
}