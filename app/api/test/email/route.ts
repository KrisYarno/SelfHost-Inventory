import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { emailService } from "@/lib/email";
import type { DeliveryNotSentReason } from "@/lib/email";

export const dynamic = "force-dynamic";

// N0 (C4): the true text for each reason the delivery switch can withhold a send.
const NOT_SENT_TEXT: Record<DeliveryNotSentReason, string> = {
  unconfigured: "SendGrid is not configured on this server.",
  off: "Email delivery is off on this server (EMAIL_DELIVERY).",
  not_allowlisted: "Your address is not on this server's email allowlist (EMAIL_ALLOWLIST).",
};

export async function POST(_request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Test data
    const testData = {
      recipientName: session.user.name || "Test User",
      items: [
        {
          productName: "Test Product A",
          currentStock: 3,
          threshold: 5,
          daysUntilEmpty: 3,
        },
        {
          productName: "Test Product B",
          currentStock: 0,
          threshold: 10,
          daysUntilEmpty: 0,
        },
        {
          productName: "Test Product C",
          currentStock: 8,
          threshold: 10,
          daysUntilEmpty: null,
        },
      ],
    };

    // Send test email to the admin's email
    if (!session.user.email) {
      return NextResponse.json({ error: "No email address found for user" }, { status: 400 });
    }

    const result = await emailService.sendLowStockDigest(session.user.email, testData);

    // No "sent" claim without a send (N0 C3): anything other than exactly
    // { sent: true } is a 409 carrying the reason's true text (a missing result
    // throws here and lands in the 500 below — never a success).
    if (result.sent !== true) {
      return NextResponse.json(
        { success: false, error: NOT_SENT_TEXT[result.reason] },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Test email sent successfully",
      to: session.user.email,
      templateId: process.env.TEMPLATE_ID,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: `Low Stock Alert - ${testData.items.length} Products Need Attention`,
      itemCount: testData.items.length,
      apiKeyConfigured: !!process.env.SENDGRID_API_KEY,
    });
  } catch (error) {
    // N0 FR2 F2: the message only (cut at 200), never the error object.
    console.error(
      "Test email failed:",
      error instanceof Error ? error.message.slice(0, 200) : "unknown"
    );
    return NextResponse.json(
      {
        error: "Failed to send test email",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
