import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
    
    if (!session || !session.user?.email) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { locationId } = body;

    if (!locationId || typeof locationId !== 'number') {
      return NextResponse.json(
        { error: 'Invalid location ID' },
        { status: 400 }
      );
    }

    // Verify location exists
    const location = await prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      return NextResponse.json(
        { error: 'Location not found' },
        { status: 404 }
      );
    }

    // Update user's default location
    const updatedUser = await prisma.user.update({
      where: { email: session.user.email },
      data: { defaultLocationId: locationId },
    });

    return NextResponse.json({
      message: 'Default location updated successfully',
      defaultLocationId: updatedUser.defaultLocationId,
    });
  } catch (error) {
    console.error('Error updating default location:', error);
    return NextResponse.json(
      { error: 'Failed to update default location' },
      { status: 500 }
    );
  }
}