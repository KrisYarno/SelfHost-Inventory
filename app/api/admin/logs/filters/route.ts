import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
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
  } catch (error) {
    console.error("Error fetching filters:", error);
    return NextResponse.json({ error: "Failed to fetch filters" }, { status: 500 });
  }
}
