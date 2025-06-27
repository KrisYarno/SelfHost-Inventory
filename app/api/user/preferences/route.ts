import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';

// GET /api/user/preferences - Get user preferences
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: parseInt(session.user.id) },
      select: {
        emailAlerts: true,
        defaultLocationId: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json(user);
  } catch (error) {
    console.error('Error fetching user preferences:', error);
    return NextResponse.json(
      { error: 'Failed to fetch preferences' },
      { status: 500 }
    );
  }
}

// PATCH /api/user/preferences - Update user preferences
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const updateData: Record<string, unknown> = {};

    // Update emailAlerts if provided
    if (typeof body.emailAlerts === 'boolean') {
      updateData.emailAlerts = body.emailAlerts;
    }

    // Update defaultLocationId if provided
    if (body.defaultLocationId !== undefined) {
      const locationId = parseInt(body.defaultLocationId);
      if (!isNaN(locationId)) {
        // Verify location exists
        const location = await prisma.location.findUnique({
          where: { id: locationId },
        });
        if (!location) {
          return NextResponse.json(
            { error: 'Invalid location' },
            { status: 400 }
          );
        }
        updateData.defaultLocationId = locationId;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields to update' },
        { status: 400 }
      );
    }

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(session.user.id) },
      data: updateData,
      select: {
        emailAlerts: true,
        defaultLocationId: true,
      },
    });

    return NextResponse.json(updatedUser);
  } catch (error) {
    console.error('Error updating user preferences:', error);
    return NextResponse.json(
      { error: 'Failed to update preferences' },
      { status: 500 }
    );
  }
}