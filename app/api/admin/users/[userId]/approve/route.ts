import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { auditService } from '@/lib/audit';
import { validateCSRFToken } from '@/lib/csrf';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const userId = parseInt(params.userId);
    if (isNaN(userId)) {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    // Update user approval status
    const user = await prisma.user.update({
      where: { id: userId },
      data: { isApproved: true },
    });

    // Log the approval action
    await auditService.logUserApproval(
      parseInt(session.user.id),
      user.id,
      user.email
    );

    return NextResponse.json({ 
      message: 'User approved successfully',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        isApproved: user.isApproved,
      }
    });
  } catch (error) {
    console.error('Error approving user:', error);
    return NextResponse.json(
      { error: 'Failed to approve user' },
      { status: 500 }
    );
  }
}