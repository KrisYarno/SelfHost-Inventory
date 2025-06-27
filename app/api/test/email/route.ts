import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { emailService } from '@/lib/email';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Test data
    const testData = {
      recipientName: session.user.name || 'Test User',
      items: [
        {
          productName: 'Test Product A',
          currentStock: 3,
          threshold: 5,
          daysUntilEmpty: 3,
        },
        {
          productName: 'Test Product B',
          currentStock: 0,
          threshold: 10,
          daysUntilEmpty: 0,
        },
        {
          productName: 'Test Product C',
          currentStock: 8,
          threshold: 10,
          daysUntilEmpty: null,
        },
      ],
    };

    // Send test email to the admin's email
    if (!session.user.email) {
      return NextResponse.json(
        { error: 'No email address found for user' },
        { status: 400 }
      );
    }
    
    await emailService.sendLowStockDigest(
      session.user.email,
      testData
    );

    return NextResponse.json({
      success: true,
      message: 'Test email sent successfully',
      to: session.user.email,
      templateId: process.env.TEMPLATE_ID,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: `Low Stock Alert - ${testData.items.length} Products Need Attention`,
      itemCount: testData.items.length,
      hasSendGridKey: !!process.env.SENDGRID_API_KEY,
      keyPrefix: process.env.SENDGRID_API_KEY?.substring(0, 10) + '...',
    });
  } catch (error) {
    console.error('Test email failed:', error);
    return NextResponse.json(
      { 
        error: 'Failed to send test email',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}