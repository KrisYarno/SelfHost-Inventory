import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { UpdateProductRequest } from "@/types/product";
import { getCurrentQuantity, isProductUnique, formatProductName } from "@/lib/products";

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

    const product = await prisma.product.findUnique({
      where: { id: productId },
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

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // Delete the product
    const product = await prisma.product.delete({
      where: { id: productId },
    });

    return NextResponse.json(product);
  } catch (error) {
    console.error("Error deleting product:", error);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 }
    );
  }
}