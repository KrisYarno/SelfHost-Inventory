import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import { getRateLimitStats } from "@/lib/rateLimit";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

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
});
