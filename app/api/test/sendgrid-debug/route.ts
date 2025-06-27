import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import sgMail from '@sendgrid/mail';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check email exists
    if (!session.user.email) {
      return NextResponse.json({ error: 'No email address found for user' }, { status: 400 });
    }

    // Initialize SendGrid
    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    }

    const tests = [];
    const userEmail = session.user.email;
    
    // Test 1: Simple text email
    try {
      const simpleMsg = {
        to: userEmail,
        from: process.env.SENDGRID_FROM_EMAIL || 'alerts@advancedresearchpep.com',
        subject: 'Test 1: Simple Text Email',
        text: 'This is a simple text email test from your inventory system.',
      };
      
      const result1 = await sgMail.send(simpleMsg);
      tests.push({
        test: 'Simple text email',
        success: true,
        statusCode: result1[0].statusCode,
        headers: result1[0].headers,
      });
    } catch (error: any) {
      tests.push({
        test: 'Simple text email',
        success: false,
        error: error.message,
        code: error.code,
        response: error.response?.body,
      });
    }

    // Test 2: HTML email without template
    try {
      const htmlMsg = {
        to: userEmail,
        from: process.env.SENDGRID_FROM_EMAIL || 'alerts@advancedresearchpep.com',
        subject: 'Test 2: HTML Email',
        text: 'This is the plain text version.',
        html: '<strong>This is the HTML version.</strong>',
      };
      
      const result2 = await sgMail.send(htmlMsg);
      tests.push({
        test: 'HTML email',
        success: true,
        statusCode: result2[0].statusCode,
      });
    } catch (error: any) {
      tests.push({
        test: 'HTML email',
        success: false,
        error: error.message,
        code: error.code,
        response: error.response?.body,
      });
    }

    // Test 3: Template email without dynamic data
    if (process.env.TEMPLATE_ID) {
      try {
        const templateMsg = {
          to: session.user.email,
          from: process.env.SENDGRID_FROM_EMAIL || 'alerts@advancedresearchpep.com',
          templateId: process.env.TEMPLATE_ID,
        };
        
        const result3 = await sgMail.send(templateMsg);
        tests.push({
          test: 'Template without data',
          success: true,
          statusCode: result3[0].statusCode,
        });
      } catch (error: any) {
        tests.push({
          test: 'Template without data',
          success: false,
          error: error.message,
          code: error.code,
          response: error.response?.body,
        });
      }
    }

    // Test 4: Template with minimal data
    if (process.env.TEMPLATE_ID) {
      try {
        const templateDataMsg = {
          to: session.user.email,
          from: process.env.SENDGRID_FROM_EMAIL || 'alerts@advancedresearchpep.com',
          templateId: process.env.TEMPLATE_ID,
          dynamicTemplateData: {
            recipientName: 'Test User',
          },
        };
        
        const result4 = await sgMail.send(templateDataMsg);
        tests.push({
          test: 'Template with minimal data',
          success: true,
          statusCode: result4[0].statusCode,
        });
      } catch (error: any) {
        tests.push({
          test: 'Template with minimal data',
          success: false,
          error: error.message,
          code: error.code,
          response: error.response?.body,
        });
      }
    }

    return NextResponse.json({
      success: true,
      config: {
        apiKeyLength: process.env.SENDGRID_API_KEY?.length,
        apiKeyPrefix: process.env.SENDGRID_API_KEY?.substring(0, 10),
        fromEmail: process.env.SENDGRID_FROM_EMAIL,
        templateId: process.env.TEMPLATE_ID,
        toEmail: session.user.email,
      },
      tests,
    });
  } catch (error) {
    console.error('Debug test failed:', error);
    return NextResponse.json(
      { 
        error: 'Debug test failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}