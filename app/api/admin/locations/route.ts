import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name } = await request.json();

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Location name is required" },
        { status: 400 }
      );
    }

    // Check if location already exists
    const existing = await prisma.location.findFirst({
      where: {
        name: {
          equals: name.trim(),
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
        name: name.trim(),
      },
    });

    return NextResponse.json({
      location,
      message: "Location created successfully",
    });
  } catch (error) {
    console.error('Error creating location:', error);
    return NextResponse.json(
      { error: "Failed to create location" },
      { status: 500 }
    );
  }
}