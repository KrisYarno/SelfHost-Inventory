import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ZodError } from "zod";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { ProductFilters } from "@/types/product";
import {
  getProductsWithQuantities,
  isProductUnique,
  getNextNumericValue,
  formatProductName,
} from "@/lib/products";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
import { ProductCreateSchema } from "@/lib/validation/product";
import {
  applyRateLimitHeaders,
  enforceRateLimit,
  RateLimitError,
} from "@/lib/rateLimit";

export const dynamic = 'force-dynamic';

// GET /api/products - List all products with filters
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    
    // Parse filters from query params
    const filters: ProductFilters = {
      search: searchParams.get("search") || undefined,
      sortBy: searchParams.get("sortBy") as ProductFilters["sortBy"] || "name",
      sortOrder: searchParams.get("sortOrder") as ProductFilters["sortOrder"] || "asc",
      page: parseInt(searchParams.get("page") || "1"),
      pageSize: parseInt(searchParams.get("pageSize") || "25"),
    };

    // Get location ID from query params (optional - if not provided, get totals)
    const locationId = searchParams.get("locationId");
    const getTotal = searchParams.get("getTotal") === "true" || !locationId;

    const { products, total } = await getProductsWithQuantities(filters, locationId ? parseInt(locationId) : undefined, getTotal);

    return NextResponse.json({
      products,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 }
    );
  }
}

// POST /api/products - Create new product (Admin only)
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    // Check if user is authenticated and is an admin
    if (!session?.user?.isApproved || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, "products:POST", {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = ProductCreateSchema.parse(await request.json());
    
    // Check uniqueness if baseName and variant are provided
    if (body.baseName && body.variant) {
      const isUnique = await isProductUnique(body.baseName, body.variant);
      if (!isUnique) {
        return NextResponse.json(
          { error: "Product with this base name and variant already exists" },
          { status: 400 }
        );
      }
    }

    // Get default numeric value if not provided
    const numericValue = body.numericValue ?? await getNextNumericValue();

    // Use provided locationId or default to 1
    const locationId = body.locationId || 1;

    // Verify location exists
    const location = await prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      return NextResponse.json(
        { error: "Invalid location ID" },
        { status: 400 }
      );
    }

    const costPrice = Number(body.costPrice ?? 0);
    const retailPrice = Number(body.retailPrice ?? 0);

    // Create the product
    const product = await prisma.product.create({
      data: {
        name: body.name.trim(),
        baseName: body.baseName?.trim() || null,
        variant: body.variant?.trim() || null,
        unit: body.unit?.trim() || null,
        numericValue,
        quantity: 0,
        location: locationId,
        lowStockThreshold: body.lowStockThreshold ?? 10,
        costPrice: costPrice >= 0 ? costPrice : 0,
        retailPrice: retailPrice >= 0 ? retailPrice : 0,
      },
    });

    // Log the product creation
    await auditService.logProductCreate(
      parseInt(session.user.id),
      product.id,
      product.name
    );

    const response = NextResponse.json(product, { status: 201 });
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

    console.error("Error creating product:", error);
    return NextResponse.json(
      { error: "Failed to create product" },
      { status: 500 }
    );
  }
}
