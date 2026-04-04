import { NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();

  // Get unique users and locations
  const [users, locations] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
      },
      orderBy: { username: "asc" },
    }),
    prisma.location.findMany({
      select: { name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email || u.username,
    })),
    locations: locations.map((l) => l.name),
  });
});
