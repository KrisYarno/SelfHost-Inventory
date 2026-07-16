import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/version — the build-identity probe (2026-07-16 stale-image
 * incident). `build-info.json` is written INTO the image by
 * scripts/build-info.sh (Dockerfile builder stage): sha from the GIT_SHA build
 * arg, falling back to the .git/HEAD+refs the .dockerignore negations let into
 * the build context.
 *
 * The contract: after any rebuild, /api/version MUST equal
 * `git rev-parse HEAD` — `docker compose up -d` silently restarts the OLD
 * image when a build failed, and this probe is how that trap is caught before
 * a live drive or deploy is trusted.
 *
 * Outside an image build (next dev, jest) the file is absent and both fields
 * read "unknown"; the probe never throws. Unauthenticated by design (same
 * posture as /api/healthz; a commit sha is not a secret on this self-hosted
 * deployment).
 */
export async function GET() {
  let sha = "unknown";
  let builtAt = "unknown";
  try {
    const raw = readFileSync(path.join(process.cwd(), "build-info.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.sha === "string" && rec.sha) sha = rec.sha;
      if (typeof rec.builtAt === "string" && rec.builtAt) builtAt = rec.builtAt;
    }
  } catch {
    // Absent / unreadable / malformed — degrade to "unknown", never fail.
  }
  return NextResponse.json(
    { sha, builtAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
