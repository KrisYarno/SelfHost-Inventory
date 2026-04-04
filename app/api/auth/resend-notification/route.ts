import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";

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

  const response = NextResponse.json({
    message: "Notification sent to administrators",
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
