import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getRateLimitStats } from "@/lib/rateLimit";

export async function GET(request: NextRequest) {
  // Check if user is admin
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  if (!token || !token.isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stats = getRateLimitStats();

  // Group by scope prefix for a summary view
  const grouped = new Map<string, { current: number; entries: number; resetTime: string }>();

  for (const entry of stats) {
    const scope = entry.key.split(":").slice(0, -1).join(":") || entry.key;
    const existing = grouped.get(scope);
    if (!existing || entry.count > existing.current) {
      grouped.set(scope, {
        current: entry.count,
        entries: (existing?.entries ?? 0) + 1,
        resetTime: new Date(entry.expiresAt).toISOString(),
      });
    } else {
      existing.entries += 1;
    }
  }

  const rateLimitData = Array.from(grouped.entries()).map(([scope, data]) => ({
    endpoint: scope,
    current: data.current,
    entries: data.entries,
    resetTime: data.resetTime,
  }));

  return NextResponse.json(rateLimitData);
}
