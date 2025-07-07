import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all products with their location quantities (excluding soft deleted)
    const products = await prisma.product.findMany({
      where: {
        deletedAt: null,
      },
      include: {
        product_locations: {
          include: {
            locations: true,
          },
        },
      },
      orderBy: [
        { baseName: 'asc' },
        { variant: 'asc' },
      ],
    });

    // Get all locations for column headers
    const locations = await prisma.location.findMany({
      orderBy: { name: 'asc' },
    });

    // Build CSV content
    const headers = ['Product Name', 'Base Name', 'Variant', 'Total Quantity'];
    locations.forEach(loc => headers.push(loc.name));
    
    const rows = [headers];

    products.forEach(product => {
      const locationQuantities = new Map(
        product.product_locations.map(pl => [pl.locationId, pl.quantity])
      );
      
      const totalQuantity = Array.from(locationQuantities.values()).reduce(
        (sum, qty) => sum + qty, 
        0
      );

      const row = [
        product.name,
        product.baseName || '',
        product.variant || '',
        totalQuantity.toString(),
      ];

      locations.forEach(loc => {
        row.push((locationQuantities.get(loc.id) || 0).toString());
      });

      rows.push(row);
    });

    // Convert to CSV string
    const csvContent = rows
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
      .join('\n');

    // Return as downloadable file
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="inventory-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  } catch (error) {
    console.error('Error exporting inventory data:', error);
    return NextResponse.json(
      { error: "Failed to export inventory data" },
      { status: 500 }
    );
  }
}