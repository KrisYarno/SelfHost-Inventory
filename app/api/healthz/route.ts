import { NextResponse } from "next/server";
import { encryptionKeyReadiness } from "@/lib/assistant/readiness";

export const dynamic = "force-dynamic";

// Liveness + readiness probe (Lane 4, codex #14). `status: "ok"` stays the
// liveness signal (the Dockerfile HEALTHCHECK only needs a 200); the new
// `readiness` block is a non-fatal report — a not-ready encryption key does not
// fail liveness, it surfaces so provider/credential operations are known-degraded.
export async function GET() {
  const encryptionKey = encryptionKeyReadiness();
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    readiness: {
      encryptionKey,
    },
  });
}
