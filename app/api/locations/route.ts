import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  await requireApproved();

  const locations = await prisma.location.findMany({
    orderBy: {
      name: "asc",
    },
  });

  return NextResponse.json(locations);
});
