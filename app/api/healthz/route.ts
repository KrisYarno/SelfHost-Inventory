import { NextResponse } from "next/server";
import { encryptionKeyReadiness } from "@/lib/assistant/readiness";
import { getPostureView } from "@/lib/platforms/egress";

export const dynamic = "force-dynamic";

// Liveness + readiness probe (Lane 4, codex #14). `status: "ok"` stays the
// liveness signal (the Dockerfile HEALTHCHECK only needs a 200); the new
// `readiness` block is a non-fatal report — a not-ready encryption key does not
// fail liveness, it surfaces so provider/credential operations are known-degraded.
//
// Lane 6 (codex #16): the effective platform-write posture is exposed here so an
// env change that didn't take effect — or a config we could not parse — is
// visible at the boundary. `platformWrites.invalidEnv` is the RED flag: it means
// PLATFORM_WRITES / PLATFORM_WRITE_CAPABILITIES contained a value we did not
// understand, so writes fell closed to OFF.
export async function GET() {
  const encryptionKey = encryptionKeyReadiness();

  // Never let a posture read (which hits the DB for the kill switch) fail
  // liveness. Degrade the block instead.
  let platformWrites;
  try {
    const view = await getPostureView();
    platformWrites = {
      effective: view.effective,
      capabilities: view.capabilities,
      killSwitchEngaged: view.killSwitchEngaged,
      invalidEnv: view.invalidEnv,
      invalidReasons: view.invalidReasons,
      label: view.label,
    };
  } catch {
    platformWrites = {
      effective: "off" as const,
      capabilities: [] as string[],
      killSwitchEngaged: true,
      invalidEnv: true,
      invalidReasons: ["posture_read_failed"],
      label: "Platform writes: OFF (posture unavailable)",
    };
  }

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    readiness: {
      encryptionKey,
    },
    platformWrites,
  });
}
