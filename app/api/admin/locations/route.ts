import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { AppError } from "@/lib/error-handling";
import { recordChange } from "@/lib/change-tracking";
import { CreateLocationSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  const parsed = CreateLocationSchema.parse(body);

  // P-B11: dup-check + max-id read + create + LOCATION_CREATE record wrapped in
  // ONE Serializable tx. Location.id is not auto-increment, so the previous
  // read-max-then-assign was a live concurrent-id race; Serializable closes it
  // while the recording tx exists anyway.
  const location = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.location.findFirst({
        where: { name: { equals: parsed.name } },
      });

      if (existing) {
        throw new AppError(
          "Location with this name already exists",
          "LOCATION_NAME_TAKEN",
          400
        );
      }

      const maxIdResult = await tx.location.aggregate({ _max: { id: true } });
      const nextId = (maxIdResult._max.id || 0) + 1;

      const created = await tx.location.create({
        data: { id: nextId, name: parsed.name },
      });

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "LOCATION_CREATE",
        entityType: "LOCATION",
        entityId: created.id,
        action: `Created location "${created.name}"`,
        details: { name: created.name },
      });

      return created;
    },
    { isolationLevel: "Serializable" }
  );

  return NextResponse.json({
    location,
    message: "Location created successfully",
  });
});
