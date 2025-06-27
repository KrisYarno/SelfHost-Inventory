import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get unique users and locations
    const [users, locations] = await Promise.all([
      prisma.user.findMany({
        select: { username: true },
        orderBy: { username: 'asc' },
      }),
      prisma.location.findMany({
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return NextResponse.json({
      users: users.map(u => u.username),
      locations: locations.map(l => l.name),
    });
  } catch (error) {
    console.error('Error fetching filters:', error);
    return NextResponse.json(
      { error: "Failed to fetch filters" },
      { status: 500 }
    );
  }
}