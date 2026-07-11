import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getProductTimeline, type TimelineCursor } from "@/lib/history/union-timeline";

export const dynamic = "force-dynamic";

// GET /api/products/[id]/history — the per-product union timeline (Lane 3 spec
// §3 D2 as amended by R-L2..R-L5). Guard: requireApproved (same tier as the
// ledger read paths). Product-existence 404. Keyset pagination: `before` is
// base64url(JSON TimelineCursor); `limit` is 1-100. All merge/redaction logic
// lives in lib/history/union-timeline.ts — this route only validates + delegates.

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().min(1).optional(),
});

// The decoded cursor shape (the getProductTimeline TimelineCursor contract).
const cursorSchema = z.object({
  ts: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid cursor timestamp"),
  lastEventId: z.number().int(),
  lastLedgerId: z.number().int(),
});

/** base64url(JSON) -> TimelineCursor, or null on any malformed input. Never throws. */
function decodeCursor(raw: string): TimelineCursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = cursorSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const { user } = await requireApproved();

    const productId = parseInt(params.id, 10);
    if (Number.isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    // Validate paging inputs (400 on out-of-range limit or a malformed cursor).
    const sp = request.nextUrl.searchParams;
    const parsed = querySchema.safeParse({
      limit: sp.get("limit") ?? undefined,
      before: sp.get("before") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
    }

    let before: TimelineCursor | undefined;
    if (parsed.data.before !== undefined) {
      const decoded = decodeCursor(parsed.data.before);
      if (!decoded) {
        return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
      }
      before = decoded;
    }

    // Product existence (anti-enumeration: identical 404 for missing product).
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const result = await getProductTimeline({
      productId,
      caller: { userId: user.id, isAdmin: user.isAdmin },
      before,
      limit: parsed.data.limit,
    });

    return NextResponse.json(result);
  },
);
