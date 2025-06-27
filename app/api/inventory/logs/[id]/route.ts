import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const logId = parseInt(params.id);
    if (isNaN(logId)) {
      return NextResponse.json({ error: 'Invalid log ID' }, { status: 400 });
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
      return NextResponse.json({ error: 'Log entry not found' }, { status: 404 });
    }

    return NextResponse.json(log);
  } catch (error) {
    console.error('Error fetching inventory log:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inventory log' },
      { status: 500 }
    );
  }
}