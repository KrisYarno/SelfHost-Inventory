import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError } from "@/lib/error-handling";
import {
  effectiveLowStockThreshold,
  getLowStockDefault,
  stockState,
} from "@/lib/stock-threshold";

export const dynamic = "force-dynamic";

/** Facelift F2-1: the stock filter. Absent = `all`. */
const STOCK_FILTERS = ["all", "in-stock", "low", "out"] as const;
type StockFilter = (typeof STOCK_FILTERS)[number];

/** F2-1 / A10: `pageSize` is capped (C2-9); a NaN asks for the default. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 500;

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get("search") || "";
  // A10: a NaN or < 1 page reads page 1; a NaN pageSize reads 25, and every
  // pageSize is clamped to 1..500. The response echoes the clamped values.
  const pageParam = parseInt(searchParams.get("page") || "1");
  const page = Number.isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const pageSizeParam = parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.isNaN(pageSizeParam) ? DEFAULT_PAGE_SIZE : pageSizeParam),
  );
  const sortByParam = searchParams.get("sortBy");
  const allowedSorts = ["name", "baseName", "numericValue", "baseNameNumeric"] as const;
  const sortBy = allowedSorts.includes(sortByParam as any)
    ? (sortByParam as (typeof allowedSorts)[number])
    : "baseNameNumeric";
  const sortOrder = (searchParams.get("sortOrder") || "asc") as "asc" | "desc";
  const locationId = searchParams.get("locationId");

  // F2-1: `stock` narrows the list by each product's stock state (absent = all).
  const stockParam = searchParams.get("stock");
  if (stockParam !== null && !STOCK_FILTERS.includes(stockParam as StockFilter)) {
    throw new AppError("Invalid stock filter", "VALIDATION_ERROR", 400);
  }
  const stock: StockFilter = (stockParam as StockFilter | null) ?? "all";

  // F2-1: `hereLocationId` picks the row each product's `hereQuantity` reads. It
  // never changes `currentQuantity` (that is the legacy `locationId`'s job).
  const hereParam = searchParams.get("hereLocationId");
  let hereLocationId: number | null = null;
  if (hereParam !== null) {
    const parsed = /^\d+$/.test(hereParam) ? Number(hereParam) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new AppError("Invalid location", "VALIDATION_ERROR", 400);
    }
    hereLocationId = parsed;
  }

  const orderBy: Prisma.ProductOrderByWithRelationInput[] = [];

  if (sortBy === "baseNameNumeric") {
    orderBy.push({ baseName: sortOrder }, { numericValue: sortOrder }, { variant: sortOrder });
  } else if (sortBy === "name") {
    orderBy.push({ name: sortOrder });
  } else if (sortBy === "baseName") {
    orderBy.push({ baseName: sortOrder });
  } else if (sortBy === "numericValue") {
    orderBy.push({ numericValue: sortOrder });
  }

  orderBy.push({ name: "asc" });
  // Facelift FR1-6: a final `id` makes the order total, so the export's pages
  // (500 at a time) never repeat or skip a row among exact ties. Both paths.
  orderBy.push({ id: "asc" });

  // SHOW contract: provisional (PENDING_REVIEW) products stay listed — do NOT add
  // an approvalStatus filter. Locked by __tests__/integration/read-path-isolation.test.ts.
  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { baseName: { contains: search } },
            { variant: { contains: search } },
          ],
        }
      : {}),
  };

  // A9: every row is ALWAYS read — the total, the here row and the legacy
  // `locationId` quantity are all derived from it in code below.
  const include = {
    product_locations: {
      select: { quantity: true, locationId: true },
    },
  } satisfies Prisma.ProductInclude;

  const legacyLocationId = locationId ? parseInt(locationId) : null;

  const toWire = (
    row: Prisma.ProductGetPayload<{ include: typeof include }>,
    lowStockDefault: number,
  ) => {
    let currentQuantity = 0;

    if (locationId) {
      currentQuantity =
        row.product_locations.find((pl) => pl.locationId === legacyLocationId)?.quantity || 0;
    } else {
      currentQuantity = row.product_locations.reduce((sum, pl) => sum + pl.quantity, 0);
    }

    // F2-1: `null` iff the product has NO stock row (a structural "no record",
    // never shown as 0). A product whose only row is 0 reads 0.
    const totalQuantity =
      row.product_locations.length === 0
        ? null
        : row.product_locations.reduce((sum, pl) => sum + pl.quantity, 0);
    const hereQuantity =
      hereLocationId === null
        ? null
        : (row.product_locations.find((pl) => pl.locationId === hereLocationId)?.quantity ?? null);

    // The loc-1 `products.quantity` mirror is retired (B2.5) — strip it before
    // the spread so a dead column never reaches the wire. `currentQuantity`,
    // computed from product_locations above, is the only quantity we ship.
    const { quantity: _retiredMirror, ...product } = row;

    return {
      ...product,
      currentQuantity,
      totalQuantity,
      hereQuantity,
      // F2-2: the one place the five states are decided, on the TOTAL.
      stockState: stockState(
        totalQuantity,
        effectiveLowStockThreshold(row.lowStockThreshold, lowStockDefault),
      ),
      product_locations: undefined,
    };
  };

  let products: ReturnType<typeof toWire>[];
  let total: number;

  if (stock === "all") {
    const [rows, count, lowStockDefault] = await Promise.all([
      prisma.product.findMany({
        where,
        include,
        orderBy,
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      prisma.product.count({ where }),
      getLowStockDefault(),
    ]);
    products = rows.map((row) => toWire(row, lowStockDefault));
    total = count;
  } else {
    // F2-1: the filtered path reads EVERY match (same where, same order), keeps
    // the rows in the asked state, and pages the result itself.
    const [rows, lowStockDefault] = await Promise.all([
      prisma.product.findMany({ where, include, orderBy }),
      getLowStockDefault(),
    ]);
    const matches = rows
      .map((row) => toWire(row, lowStockDefault))
      .filter((p) => {
        if (stock === "in-stock") return p.totalQuantity !== null && p.totalQuantity > 0;
        if (stock === "low") return p.stockState === "low";
        // `out`: nothing usable on hand.
        return p.stockState === "out" || p.stockState === "below-zero" || p.stockState === "no-record";
      });
    total = matches.length;
    products = matches.slice((page - 1) * pageSize, page * pageSize);
  }

  return NextResponse.json({
    products,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    hereLocationId,
    // F2 B5: the filter this answer describes, so a count never mixes two answers.
    stock,
    // Facelift FR1-10: the search this answer applied (`""` for none), so the
    // list's sentences and its export describe the answer on screen.
    search,
  });
});
