import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { CreateLocationSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  const parsed = CreateLocationSchema.parse(body);

  // Check if location already exists
  const existing = await prisma.location.findFirst({
    where: {
      name: {
        equals: parsed.name,
      },
    },
  });

  if (existing) {
    return NextResponse.json(
      { error: "Location with this name already exists" },
      { status: 400 }
    );
  }

  // Get the next available ID (since location.id is not auto-increment)
  const maxIdResult = await prisma.location.aggregate({
    _max: {
      id: true,
    },
  });

  const nextId = (maxIdResult._max.id || 0) + 1;

  // Create new location
  const location = await prisma.location.create({
    data: {
      id: nextId,
      name: parsed.name,
    },
  });

  return NextResponse.json({
    location,
    message: "Location created successfully",
  });
});
