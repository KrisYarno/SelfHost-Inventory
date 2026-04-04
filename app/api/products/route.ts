import { NextRequest, NextResponse } from "next/server";
import { requireApproved, requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { ProductFilters } from "@/types/product";
import { getProductsWithQuantities, isProductUnique, formatProductName } from "@/lib/products";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
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

// POST /api/products - Create new product (Admin only)
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, "products:POST", {
    identifier: user.id,
  });

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

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

  const costPrice = Number(body.costPrice ?? 0);
  const retailPrice = Number(body.retailPrice ?? 0);

  const product = await prisma.product.create({
    data: {
      name,
      baseName,
      variant,
      unit,
      numericValue,
      quantity: 0,
      location: locationId,
      lowStockThreshold: body.lowStockThreshold ?? 10,
      costPrice: costPrice >= 0 ? costPrice : 0,
      retailPrice: retailPrice >= 0 ? retailPrice : 0,
    },
  });

  await auditService.logProductCreate(user.id, product.id, product.name);

  const response = NextResponse.json(product, { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
