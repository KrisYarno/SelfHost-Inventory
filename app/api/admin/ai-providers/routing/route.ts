import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import {
  AiSurfaceConfigSchema,
  validateSurfaceConfig,
  type AiSurfaceConfig,
} from "@/lib/validation/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AI_SURFACE_CONFIG_KEY = "aiSurfaceConfig";

function parseConfig(raw: string | null | undefined): AiSurfaceConfig | null {
  if (!raw) return null;
  try {
    return AiSurfaceConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The model the assistant surface currently resolves to (override else default). */
function resolvedAssistant(config: AiSurfaceConfig | null) {
  if (!config) return null;
  return config.surfaces?.assistant ?? config.default;
}

/**
 * GET /api/admin/ai-providers/routing — the current surface-routing config plus
 * the resolved assistant {providerKind, model} (D-B8: the resolved assistant
 * model is always displayed).
 */
export const GET = apiHandler(async () => {
  await requireAdmin();

  const setting = await prisma.systemSetting.findUnique({
    where: { key: AI_SURFACE_CONFIG_KEY },
    select: { value: true },
  });
  const config = parseConfig(setting?.value);

  return NextResponse.json({ config, resolved: resolvedAssistant(config) });
});

/**
 * PUT /api/admin/ai-providers/routing — set the surface-routing default. The
 * config is validated against the CURRENT provider rows INSIDE the transaction
 * (validateSurfaceConfig: provider exists, is enabled, has its credential, and
 * lists the model — else a 400). The write emits a SETTINGS_UPDATE diff event.
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user: adminUser } = await requireAdmin();
  await requireCSRF(request);

  const next = AiSurfaceConfigSchema.parse(await request.json());

  await prisma.$transaction(async (tx) => {
    // Invariant check against live provider state (D2), inside the tx.
    await validateSurfaceConfig(tx, next);

    const current = await tx.systemSetting.findUnique({
      where: { key: AI_SURFACE_CONFIG_KEY },
      select: { value: true },
    });
    const before = parseConfig(current?.value);
    const value = JSON.stringify(next);

    await tx.systemSetting.upsert({
      where: { key: AI_SURFACE_CONFIG_KEY },
      update: { value },
      create: { key: AI_SURFACE_CONFIG_KEY, value },
    });

    await recordChange(tx, {
      actor: { userId: adminUser.id },
      actionType: "SETTINGS_UPDATE",
      entityType: "SETTINGS",
      entityId: AI_SURFACE_CONFIG_KEY,
      action: "Updated AI routing defaults",
      changes: {
        default: { from: before?.default ?? null, to: next.default },
        assistant: {
          from: before?.surfaces?.assistant ?? null,
          to: next.surfaces?.assistant ?? null,
        },
      },
    });
  });

  return NextResponse.json({ config: next, resolved: resolvedAssistant(next) });
});
