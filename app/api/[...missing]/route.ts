import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Every `/api/...` path no route matches (facelift FR1-5; GR-5 = OCR-5).
 * Static and dynamic API segments still win; this only catches what nothing
 * else does, so an unknown API path answers a JSON 404 a client can read —
 * never the shell's HTML not-found page (which retires REV 3's accepted
 * "in-shell 404 for `/api/...`").
 */
function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
