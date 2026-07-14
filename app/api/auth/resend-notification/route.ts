import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { emailService } from "@/lib/email";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const session = await getSession();

  if (!session || !session.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get the user from database
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (user.isApproved) {
    return NextResponse.json({ error: "User is already approved" }, { status: 400 });
  }

  const rateLimitHeaders = enforceRateLimit(request, "auth:resend-notification", {
    identifier: session.user.id ?? session.user.email ?? undefined,
  });

  // S5: actually notify the administrators (was a stub that claimed "sent" while
  // sending nothing). Look up active admins and dispatch a reminder email.
  const admins = await prisma.user.findMany({
    where: { isAdmin: true, deletedAt: null },
    select: { email: true },
  });
  const adminEmails = admins.map((a) => a.email).filter(Boolean);

  const delivery = await emailService.sendApprovalReminderEmail(adminEmails, {
    email: user.email,
    username: user.username,
  });

  // Record a TRUTHFUL change-tracking event: details.delivered reflects whether
  // the provider actually accepted the message (false when unconfigured or on a
  // provider throw). Send-then-record ordering (codex #14/#20).
  await prisma.$transaction(async (tx) => {
    await recordChange(tx, {
      actor: { kind: "USER", userId: user.id },
      actionType: "USER_APPROVAL_REMINDER_SENT",
      entityType: "USER",
      entityId: user.id,
      action: "Requested administrator review of a pending account",
      details: {
        attempted: delivery.attempted,
        delivered: delivery.sent,
        adminCount: adminEmails.length,
      },
    });
  });

  // Honest copy regardless of provider state — never a false "sent" claim.
  const response = NextResponse.json({
    message: "Administrators will review your account",
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
