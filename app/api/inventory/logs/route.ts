import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import type { InventoryLogFilters, InventoryLogResponse } from '@/types/inventory';
import { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    
    // Parse filters
    const filters: InventoryLogFilters = {
      productId: searchParams.get('productId') ? parseInt(searchParams.get('productId')!) : undefined,
      locationId: searchParams.get('locationId') ? parseInt(searchParams.get('locationId')!) : undefined,
      userId: searchParams.get('userId') ? parseInt(searchParams.get('userId')!) : undefined,
      logType: searchParams.get('logType') as any,
      startDate: searchParams.get('startDate') ? new Date(searchParams.get('startDate')!) : undefined,
      endDate: searchParams.get('endDate') ? new Date(searchParams.get('endDate')!) : undefined,
    };

    // Pagination
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '50')));
    const skip = (page - 1) * pageSize;

    // Build where clause
    const where: Prisma.inventory_logsWhereInput = {};
    
    if (filters.productId) where.productId = filters.productId;
    if (filters.locationId) where.locationId = filters.locationId;
    if (filters.userId) where.userId = filters.userId;
    if (filters.logType) where.logType = filters.logType;
    
    if (filters.startDate || filters.endDate) {
      where.changeTime = {};
      if (filters.startDate) where.changeTime.gte = filters.startDate;
      if (filters.endDate) where.changeTime.lte = filters.endDate;
    }

    // Run count and data queries in parallel
    const [total, logs] = await Promise.all([
      prisma.inventory_logs.count({ where }),
      prisma.inventory_logs.findMany({
        where,
        include: {
          users: {
            select: {
              id: true,
              username: true,
              email: true,
            },
          },
          products: {
            select: {
              id: true,
              name: true,
              baseName: true,
              variant: true,
            },
          },
          locations: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: {
          changeTime: 'desc',
        },
        skip,
        take: pageSize,
      }),
    ]);

    const response: InventoryLogResponse = {
      logs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching inventory logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inventory logs' },
      { status: 500 }
    );
  }
}