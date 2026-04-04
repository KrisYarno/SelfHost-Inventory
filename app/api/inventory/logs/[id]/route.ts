import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  await requireApproved();

  const logId = parseInt(params.id);
  if (isNaN(logId)) {
    return NextResponse.json({ error: "Invalid log ID" }, { status: 400 });
  }

  const log = await prisma.inventory_logs.findUnique({
    where: { id: logId },
    include: {
      users: true,
      products: true,
      locations: true,
    },
  });

  if (!log) {
    return NextResponse.json({ error: "Log entry not found" }, { status: 404 });
  }

  return NextResponse.json(log);
});
