import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import {
  BatchUpdateResult,
  FailedUpdate,
  MassUpdateChange,
  UpdateFailureReason,
  PaginatedMassUpdateResponse,
} from "@/types/mass-update-errors";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * GET - Fetch products with current inventory levels
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get("search") || "";
  const category = searchParams.get("category") || "all";

  // Pagination parameters
  const page = parseInt(searchParams.get("page") || "0");
  const pageSize = parseInt(searchParams.get("pageSize") || "0");
  const isPaginated = pageSize > 0;

  // Build where clause - exclude soft deleted products
  const whereClause: any = {
    deletedAt: null,
  };
  if (search) {
    whereClause.OR = [
      { name: { contains: search } },
      { baseName: { contains: search } },
      { variant: { contains: search } },
    ];
  }
  if (category !== "all") {
    whereClause.baseName = category === "Uncategorized" ? null : category;
  }

  // Get total count only if paginated (performance optimization)
  const totalCount = isPaginated
    ? await prisma.product.count({
        where: whereClause,
      })
    : 0;

  // Get products with their current quantities at each location
  const products = await prisma.product.findMany({
    where: whereClause,
    include: {
      product_locations: {
        include: {
          locations: true,
        },
      },
    },
    orderBy: [{ baseName: "asc" }, { variant: "asc" }],
    ...(isPaginated
      ? {
          skip: page * pageSize,
          take: pageSize,
        }
      : {}),
  });

  // Get all locations
  const locations = await prisma.location.findMany({
    orderBy: { name: "asc" },
  });

  // Transform data for the UI
  const transformedProducts = products.map((product) => {
    // Create a map of current quantities by location
    const locationQuantities = new Map(
      product.product_locations.map((pl) => [pl.locationId, pl.quantity])
    );

    // Create location entries for each product
    const productLocations = locations.map((location) => ({
      locationId: location.id,
      locationName: location.name,
      currentQuantity: locationQuantities.get(location.id) || 0,
      newQuantity: null,
      delta: 0,
      hasChanged: false,
    }));

    return {
      productId: product.id,
      productName: product.name,
      baseName: product.baseName || "Uncategorized",
      variant: product.variant,
      locations: productLocations,
    };
  });

  // Build response with pagination metadata
  const response: PaginatedMassUpdateResponse = {
    products: transformedProducts,
    locations: locations.map((loc) => ({ id: loc.id, name: loc.name })),
    totalProducts: isPaginated ? totalCount : transformedProducts.length,
    totalChanges: 0,
    // Pagination metadata
    ...(isPaginated && {
      pagination: {
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
        totalItems: totalCount,
        hasNext: (page + 1) * pageSize < totalCount,
        hasPrevious: page > 0,
      },
    }),
  };

  return NextResponse.json(response);
});

// Helper function to create failure record
function createFailure(
  change: MassUpdateChange,
  reason: UpdateFailureReason,
  message: string,
  canRetry: boolean = true
): FailedUpdate {
  return {
    productId: change.productId,
    productName: change.productName || `Product ${change.productId}`,
    locationId: change.locationId,
    locationName: change.locationName || `Location ${change.locationId}`,
    attemptedQuantity: change.newQuantity,
    currentQuantity: change.newQuantity - change.delta,
    reason,
    message,
    timestamp: new Date(),
    canRetry,
  };
}

// POST - Save mass inventory updates with robust error handling
export const POST = apiHandler(async (request: NextRequest) => {
  console.log("=== MASS UPDATE POST START ===");
  console.log("Request method:", request.method);
  console.log("Request URL:", request.url);
  console.log("Request headers:", Object.fromEntries(request.headers.entries()));

  const { user } = await requireAdmin();
  console.log(
    "Session:",
    { userId: user.id, isAdmin: user.isAdmin }
  );

  await requireCSRF(request);

  let body;
  try {
    body = await request.json();
    console.log("Request body parsed successfully:", {
      hasChanges: !!body.changes,
      changesLength: body.changes?.length,
      note: body.note,
      isRetry: body.isRetry,
      allowPartial: body.allowPartial,
    });
  } catch (parseError) {
    console.error("Failed to parse request body:", parseError);
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }

  const { changes, note: _note, isRetry: _isRetry = false } = body;

  if (!changes || !Array.isArray(changes) || changes.length === 0) {
    console.log("No changes provided or invalid format");
    return NextResponse.json({ error: "No changes provided" }, { status: 400 });
  }

  console.log(`Processing ${changes.length} changes`);

  // Pre-validate all changes
  const validationFailures: FailedUpdate[] = [];
  const validChanges: MassUpdateChange[] = [];

  for (const change of changes) {
    if (
      !change.productId ||
      !change.locationId ||
      change.newQuantity === null ||
      change.newQuantity === undefined
    ) {
      validationFailures.push(
        createFailure(change, "VALIDATION_ERROR", "Missing required fields", false)
      );
      continue;
    }

    if (change.newQuantity < 0) {
      validationFailures.push(
        createFailure(change, "VALIDATION_ERROR", "Quantity cannot be negative", false)
      );
      continue;
    }

    if (!Number.isInteger(change.newQuantity)) {
      validationFailures.push(
        createFailure(change, "VALIDATION_ERROR", "Quantity must be a whole number", false)
      );
      continue;
    }

    validChanges.push(change);
  }

  // If all changes failed validation, return early
  if (validChanges.length === 0) {
    const result: BatchUpdateResult = {
      successful: 0,
      failed: validationFailures.length,
      partial: false,
      failures: validationFailures,
    };
    return NextResponse.json(result, { status: 400 });
  }

  // Process valid changes with individual error handling
  const processedChanges: any[] = [];
  const failures: FailedUpdate[] = [...validationFailures];
  let successCount = 0;

  // Use transaction with isolation level to prevent conflicts
  const transactionId = `mass_update_${Date.now()}_${user.id}`;

  // Process changes in batches to avoid transaction timeout
  const BATCH_SIZE = 50;
  const batches = [];
  for (let i = 0; i < validChanges.length; i += BATCH_SIZE) {
    batches.push(validChanges.slice(i, i + BATCH_SIZE));
  }

  console.log(`Processing ${validChanges.length} changes in ${batches.length} batches`);

  // Process each batch
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(
      `Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} changes`
    );

    try {
      await prisma.$transaction(
        async (tx) => {
          // Process each change individually within the transaction
          for (const change of batch) {
            try {
              const { productId, locationId, newQuantity } = change;

              // Verify product exists
              const product = await tx.product.findUnique({
                where: { id: productId },
                select: { id: true, name: true, deletedAt: true },
              });

              if (!product || product.deletedAt) {
                failures.push(
                  createFailure(
                    change,
                    "PRODUCT_NOT_FOUND",
                    `Product ${productId} not found or deleted`,
                    false
                  )
                );
                throw new Error("Product not found");
              }

              // Verify location exists
              const location = await tx.location.findUnique({
                where: { id: locationId },
                select: { id: true, name: true },
              });

              if (!location) {
                failures.push(
                  createFailure(
                    change,
                    "LOCATION_NOT_FOUND",
                    `Location ${locationId} not found`,
                    false
                  )
                );
                throw new Error("Location not found");
              }

              // Truthful delta: recompute from the in-tx current quantity, never trust the client-supplied delta (backfill reconciliation depends on logged delta == actual change). Client-version optimistic locking (reject stale overwrites) is a separate follow-up.
              const existing = await tx.product_locations.findUnique({
                where: {
                  productId_locationId: {
                    productId,
                    locationId,
                  },
                },
                select: { quantity: true },
              });
              const currentQuantity = existing?.quantity ?? 0;
              const serverDelta = newQuantity - currentQuantity;

              // Skip if no actual change (based on the REAL delta, not the client's)
              if (serverDelta === 0) {
                successCount++;
                continue;
              }

              // Create inventory log entry
              const log = await tx.inventory_logs.create({
                data: {
                  userId: user.id,
                  productId,
                  locationId,
                  delta: serverDelta,
                  changeTime: new Date(),
                  logType: "ADJUSTMENT",
                },
              });

              // Update or create product_locations entry with absolute quantity
              await tx.product_locations.upsert({
                where: {
                  productId_locationId: {
                    productId,
                    locationId,
                  },
                },
                update: {
                  quantity: newQuantity,
                  updatedAt: new Date(),
                },
                create: {
                  productId,
                  locationId,
                  quantity: newQuantity,
                },
              });

              processedChanges.push({
                ...change,
                // Carry the truthful (server-recomputed) delta forward so the
                // bulk audit entry also reflects the real change, not the client's.
                delta: serverDelta,
                logId: log.id,
                productName: product.name,
                locationName: location.name,
              });
              successCount++;
            } catch (error: any) {
              // If error wasn't already handled, create a generic failure
              if (
                !failures.find(
                  (f) => f.productId === change.productId && f.locationId === change.locationId
                )
              ) {
                const reason: UpdateFailureReason =
                  error.code === "P2002"
                    ? "CONCURRENT_UPDATE"
                    : error.code?.startsWith("P")
                      ? "DATABASE_ERROR"
                      : "UNKNOWN_ERROR";

                failures.push(
                  createFailure(
                    change,
                    reason,
                    error.message || "Unknown error occurred",
                    reason === "CONCURRENT_UPDATE"
                  )
                );
              }

              // Re-throw to trigger transaction rollback if this is an all-or-nothing update
              if (!body.allowPartial) {
                throw error;
              }
            }
          }
        },
        {
          isolationLevel: "Serializable",
          timeout: 10000, // 10 second timeout per batch
        }
      );
    } catch (transactionError: any) {
      console.error(`=== BATCH ${batchIndex + 1} TRANSACTION ERROR ===`);
      console.error("Transaction error:", transactionError);

      // If not allowing partial, convert all remaining changes to failures and stop
      if (!body.allowPartial) {
        for (let i = batchIndex; i < batches.length; i++) {
          const failBatch = batches[i];
          for (const change of failBatch) {
            if (
              !failures.find(
                (f) => f.productId === change.productId && f.locationId === change.locationId
              )
            ) {
              failures.push(
                createFailure(
                  change,
                  "DATABASE_ERROR",
                  `Batch transaction failed: ${transactionError.message || "Transaction rolled back"}`,
                  true
                )
              );
            }
          }
        }
        break;
      }
    }
  }

  // If no successes and not allowing partial, return error
  if (successCount === 0 && !body.allowPartial && failures.length > 0) {
    const result: BatchUpdateResult = {
      successful: 0,
      failed: failures.length,
      partial: false,
      failures,
      transactionId,
    };
    return NextResponse.json(result, { status: 500 });
  }

  // Build result
  const result: BatchUpdateResult = {
    successful: successCount,
    failed: failures.length,
    partial: failures.length > 0 && successCount > 0,
    failures,
    transactionId,
  };

  // Log the operation for audit (single bulk entry)
  if (successCount > 0) {
    try {
      await auditService.logBulkInventoryUpdate(
        user.id,
        processedChanges.map((c) => ({
          productId: c.productId,
          productName: c.productName,
          delta: c.delta,
        })),
        0
      );
    } catch (auditError) {
      console.error("Failed to log bulk inventory update:", auditError);
    }
  }

  return NextResponse.json(result);
});
