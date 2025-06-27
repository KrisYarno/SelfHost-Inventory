import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const locationId = parseInt(params.id);
    
    if (isNaN(locationId)) {
      return NextResponse.json({ error: "Invalid location ID" }, { status: 400 });
    }

    // Don't allow deletion of the main location (ID: 1)
    if (locationId === 1) {
      return NextResponse.json(
        { error: "Cannot delete the main location" },
        { status: 400 }
      );
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
      // In a production app, you might want to:
      // 1. Transfer all inventory to another location
      // 2. Or prevent deletion entirely
      // For now, we'll allow deletion but warn about data loss
      
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
  } catch (error) {
    console.error('Error deleting location:', error);
    return NextResponse.json(
      { error: "Failed to delete location" },
      { status: 500 }
    );
  }
}