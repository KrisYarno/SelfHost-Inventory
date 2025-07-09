import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";
import { 
  BatchUpdateResult, 
  FailedUpdate, 
  MassUpdateChange,
  UpdateFailureReason,
  PaginatedMassUpdateResponse 
} from "@/types/mass-update-errors";

export const dynamic = 'force-dynamic';

/**
 * GET - Fetch products with current inventory levels
 * 
 * Query parameters:
 * - search: Filter products by name/baseName/variant (optional)
 * - category: Filter by category/baseName (optional, default: "all")
 * - page: Page number for pagination (optional, default: 0)
 * - pageSize: Number of items per page (optional, default: 0 = no pagination)
 * 
 * Returns:
 * - products: Array of products with inventory levels per location
 * - locations: Array of all locations
 * - totalProducts: Total count of products matching filters
 * - totalChanges: Number of pending changes (always 0 on initial load)
 * - pagination: Pagination metadata (only if pageSize > 0)
 *   - page: Current page number
 *   - pageSize: Items per page
 *   - totalPages: Total number of pages
 *   - totalItems: Total number of items
 *   - hasNext: Whether there's a next page
 *   - hasPrevious: Whether there's a previous page
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
    const totalCount = isPaginated ? await prisma.product.count({
      where: whereClause,
    }) : 0;

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
      orderBy: [
        { baseName: 'asc' },
        { variant: 'asc' },
      ],
      ...(isPaginated ? {
        skip: page * pageSize,
        take: pageSize,
      } : {}),
    });

    // Get all locations
    const locations = await prisma.location.findMany({
      orderBy: { name: 'asc' },
    });

    // Transform data for the UI
    const transformedProducts = products.map(product => {
      // Create a map of current quantities by location
      const locationQuantities = new Map(
        product.product_locations.map(pl => [pl.locationId, pl.quantity])
      );

      // Create location entries for each product
      const productLocations = locations.map(location => ({
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
        baseName: product.baseName || 'Uncategorized',
        variant: product.variant,
        locations: productLocations,
      };
    });

    // Build response with pagination metadata
    const response: PaginatedMassUpdateResponse = {
      products: transformedProducts,
      locations: locations.map(loc => ({ id: loc.id, name: loc.name })),
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
        }
      })
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching mass update data:', error);
    return NextResponse.json(
      { error: "Failed to fetch inventory data" },
      { status: 500 }
    );
  }
}

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
    canRetry
  };
}

// POST - Save mass inventory updates with robust error handling
export async function POST(request: NextRequest) {
  console.log('=== MASS UPDATE POST START ===');
  console.log('Request method:', request.method);
  console.log('Request URL:', request.url);
  console.log('Request headers:', Object.fromEntries(request.headers.entries()));
  
  try {
    const session = await getServerSession(authOptions);
    console.log('Session:', session ? { userId: session.user?.id, isAdmin: session.user?.isAdmin } : 'No session');
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      console.error('CSRF validation failed', {
        headers: Object.fromEntries(request.headers.entries()),
        method: request.method,
        url: request.url
      });
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    let body;
    try {
      body = await request.json();
      console.log('Request body parsed successfully:', {
        hasChanges: !!body.changes,
        changesLength: body.changes?.length,
        note: body.note,
        isRetry: body.isRetry,
        allowPartial: body.allowPartial
      });
    } catch (parseError) {
      console.error('Failed to parse request body:', parseError);
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }
    
    const { changes, note, isRetry = false } = body;

    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      console.log('No changes provided or invalid format');
      return NextResponse.json(
        { error: "No changes provided" },
        { status: 400 }
      );
    }
    
    console.log(`Processing ${changes.length} changes`);

    // Pre-validate all changes
    const validationFailures: FailedUpdate[] = [];
    const validChanges: MassUpdateChange[] = [];

    for (const change of changes) {
      if (!change.productId || !change.locationId || change.newQuantity === null || change.newQuantity === undefined) {
        validationFailures.push(createFailure(
          change,
          'VALIDATION_ERROR',
          'Missing required fields',
          false
        ));
        continue;
      }

      if (change.newQuantity < 0) {
        validationFailures.push(createFailure(
          change,
          'VALIDATION_ERROR',
          'Quantity cannot be negative',
          false
        ));
        continue;
      }

      if (!Number.isInteger(change.newQuantity)) {
        validationFailures.push(createFailure(
          change,
          'VALIDATION_ERROR',
          'Quantity must be a whole number',
          false
        ));
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
        failures: validationFailures
      };
      return NextResponse.json(result, { status: 400 });
    }

    // Process valid changes with individual error handling
    const processedChanges: any[] = [];
    const failures: FailedUpdate[] = [...validationFailures];
    let successCount = 0;

    // Use transaction with isolation level to prevent conflicts
    const transactionId = `mass_update_${Date.now()}_${session.user.id}`;
    
    // Process changes in batches to avoid transaction timeout
    // Supports 75-100 products easily: 100 products = 2 batches of 50 each
    const BATCH_SIZE = 50; // Process 50 changes at a time
    const batches = [];
    for (let i = 0; i < validChanges.length; i += BATCH_SIZE) {
      batches.push(validChanges.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`Processing ${validChanges.length} changes in ${batches.length} batches`);
    
    // Process each batch
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} changes`);
      
      try {
        await prisma.$transaction(async (tx) => {
          // Process each change individually within the transaction
          for (const change of batch) {
          try {
            const { productId, locationId, newQuantity, delta } = change;

            // Skip if no actual change
            if (delta === 0) {
              successCount++;
              continue;
            }

            // Verify product exists
            const product = await tx.product.findUnique({
              where: { id: productId },
              select: { id: true, name: true, deletedAt: true }
            });

            if (!product || product.deletedAt) {
              failures.push(createFailure(
                change,
                'PRODUCT_NOT_FOUND',
                `Product ${productId} not found or deleted`,
                false
              ));
              throw new Error('Product not found');
            }

            // Verify location exists
            const location = await tx.location.findUnique({
              where: { id: locationId },
              select: { id: true, name: true }
            });

            if (!location) {
              failures.push(createFailure(
                change,
                'LOCATION_NOT_FOUND',
                `Location ${locationId} not found`,
                false
              ));
              throw new Error('Location not found');
            }

            // Create inventory log entry
            const log = await tx.inventory_logs.create({
              data: {
                userId: parseInt(session.user.id),
                productId,
                locationId,
                delta,
                changeTime: new Date(),
                logType: 'ADJUSTMENT',
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
                updatedAt: new Date()
              },
              create: {
                productId,
                locationId,
                quantity: newQuantity,
              },
            });

            processedChanges.push({
              ...change,
              logId: log.id,
              productName: product.name,
              locationName: location.name
            });
            successCount++;

          } catch (error: any) {
            // If error wasn't already handled, create a generic failure
            if (!failures.find(f => 
              f.productId === change.productId && 
              f.locationId === change.locationId
            )) {
              const reason: UpdateFailureReason = 
                error.code === 'P2002' ? 'CONCURRENT_UPDATE' :
                error.code?.startsWith('P') ? 'DATABASE_ERROR' :
                'UNKNOWN_ERROR';

              failures.push(createFailure(
                change,
                reason,
                error.message || 'Unknown error occurred',
                reason === 'CONCURRENT_UPDATE'
              ));
            }
            
            // Re-throw to trigger transaction rollback if this is an all-or-nothing update
            if (!body.allowPartial) {
              throw error;
            }
          }
        }

        }, {
            isolationLevel: 'Serializable',
            timeout: 10000 // 10 second timeout per batch
          });

        } catch (transactionError: any) {
          console.error(`=== BATCH ${batchIndex + 1} TRANSACTION ERROR ===`);
          console.error('Transaction error:', transactionError);
          
          // If not allowing partial, convert all remaining changes to failures and stop
          if (!body.allowPartial) {
            // Add failures for this batch and all remaining batches
            for (let i = batchIndex; i < batches.length; i++) {
              const failBatch = batches[i];
              for (const change of failBatch) {
                if (!failures.find(f => f.productId === change.productId && f.locationId === change.locationId)) {
                  failures.push(createFailure(
                    change,
                    'DATABASE_ERROR',
                    `Batch transaction failed: ${transactionError.message || 'Transaction rolled back'}`,
                    true
                  ));
                }
              }
            }
            break; // Stop processing batches
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
        transactionId
      };
      return NextResponse.json(result, { status: 500 });
    }

    // Build result
    const result: BatchUpdateResult = {
      successful: successCount,
      failed: failures.length,
      partial: failures.length > 0 && successCount > 0,
      failures,
      transactionId
    };

    // Log the operation for audit
    console.log(`Mass update ${transactionId}: ${successCount} successful, ${failures.length} failed`);
    console.log('Final result:', JSON.stringify(result, null, 2));

    return NextResponse.json(result);

  } catch (error: any) {
    console.error('=== MASS UPDATE ERROR ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Error details:', error);
    
    // Network or unexpected errors
    const result: BatchUpdateResult = {
      successful: 0,
      failed: 0, // We don't know how many changes were attempted
      partial: false,
      failures: [{
        productId: 0,
        productName: 'Unknown',
        locationId: 0,
        locationName: 'Unknown',
        attemptedQuantity: 0,
        currentQuantity: 0,
        reason: 'NETWORK_ERROR',
        message: error.message || 'Network error occurred',
        timestamp: new Date(),
        canRetry: true
      }]
    };

    return NextResponse.json(result, { status: 500 });
  }
}