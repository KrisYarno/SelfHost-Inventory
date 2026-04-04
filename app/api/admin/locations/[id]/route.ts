import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";
import { UpdateLocationSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  await requireAdmin();

  // Validate CSRF token
  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const locationId = parseInt(params.id);

  if (isNaN(locationId)) {
    return NextResponse.json({ error: "Invalid location ID" }, { status: 400 });
  }

  // Don't allow deletion of the main location (ID: 1)
  if (locationId === 1) {
    return NextResponse.json({ error: "Cannot delete the main location" }, { status: 400 });
  }

  // Check if location exists
  const location = await prisma.location.findUnique({
    where: { id: locationId },
    include: {
      _count: {
        select: {
          product_locations: true,
          inventory_logs: true,
        },
      },
    },
  });

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  // Check if location has associated data
  const hasData = location._count.product_locations > 0 || location._count.inventory_logs > 0;

  if (hasData) {
    // Delete related records first due to foreign key constraints
    await prisma.$transaction([
      prisma.product_locations.deleteMany({
        where: { locationId },
      }),
      prisma.inventory_logs.deleteMany({
        where: { locationId },
      }),
      prisma.location.delete({
        where: { id: locationId },
      }),
    ]);
  } else {
    // No associated data, safe to delete
    await prisma.location.delete({
      where: { id: locationId },
    });
  }

  return NextResponse.json({
    message: "Location deleted successfully",
    deletedId: locationId,
  });
});

export const PATCH = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  await requireAdmin();

  // Validate CSRF token
  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const locationId = parseInt(params.id);
  if (isNaN(locationId)) {
    return NextResponse.json({ error: "Invalid location ID" }, { status: 400 });
  }

  const body = await request.json();
  const parsed = UpdateLocationSchema.parse(body);

  // Check if location exists
  const location = await prisma.location.findUnique({
    where: { id: locationId },
  });

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  // Update location
  const updated = await prisma.location.update({
    where: { id: locationId },
    data: parsed,
  });

  return NextResponse.json({
    location: updated,
    message: "Location updated successfully",
  });
});
