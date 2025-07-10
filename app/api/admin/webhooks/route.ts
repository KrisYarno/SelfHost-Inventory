import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { WebhookEventStatus } from '@prisma/client';

// GET webhook events for admin monitoring
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const status = searchParams.get('status') as WebhookEventStatus | null;
    const eventType = searchParams.get('eventType');

    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {};
    if (status) {
      where.status = status;
    }
    if (eventType) {
      where.eventType = eventType;
    }

    // Get events and count
    const [events, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          eventType: true,
          webhookId: true,
          resourceId: true,
          status: true,
          attempts: true,
          lastAttemptAt: true,
          processedAt: true,
          error: true,
          createdAt: true,
          payload: true,
        },
      }),
      prisma.webhookEvent.count({ where }),
    ]);

    // Get summary stats
    const stats = await prisma.webhookEvent.groupBy({
      by: ['status'],
      _count: true,
    });

    const statusCounts = stats.reduce((acc, stat) => {
      acc[stat.status] = stat._count;
      return acc;
    }, {} as Record<string, number>);

    return NextResponse.json({
      events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      stats: {
        total,
        pending: statusCounts.PENDING || 0,
        processing: statusCounts.PROCESSING || 0,
        completed: statusCounts.COMPLETED || 0,
        failed: statusCounts.FAILED || 0,
        skipped: statusCounts.SKIPPED || 0,
      },
    });
  } catch (error) {
    console.error('Error fetching webhook events:', error);
    return NextResponse.json(
      { error: 'Failed to fetch webhook events' },
      { status: 500 }
    );
  }
}

// POST to retry or delete webhook events
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action, eventIds } = body;

    if (!action || !eventIds || !Array.isArray(eventIds)) {
      return NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'retry':
        const retried = await prisma.webhookEvent.updateMany({
          where: {
            id: { in: eventIds },
            status: { in: ['FAILED', 'COMPLETED'] },
          },
          data: {
            status: 'PENDING',
            attempts: 0,
            error: null,
          },
        });
        return NextResponse.json({
          message: `Reset ${retried.count} events for retry`,
          count: retried.count,
        });

      case 'delete':
        const deleted = await prisma.webhookEvent.deleteMany({
          where: {
            id: { in: eventIds },
            status: { in: ['COMPLETED', 'FAILED', 'SKIPPED'] },
          },
        });
        return NextResponse.json({
          message: `Deleted ${deleted.count} events`,
          count: deleted.count,
        });

      case 'skip':
        const skipped = await prisma.webhookEvent.updateMany({
          where: {
            id: { in: eventIds },
            status: { in: ['PENDING', 'FAILED'] },
          },
          data: {
            status: 'SKIPPED',
          },
        });
        return NextResponse.json({
          message: `Skipped ${skipped.count} events`,
          count: skipped.count,
        });

      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Error processing webhook action:', error);
    return NextResponse.json(
      { error: 'Failed to process action' },
      { status: 500 }
    );
  }
}