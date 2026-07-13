import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { encryptValue } from "@/lib/encryption";
import { recordChange, diff, type ChangeDiff } from "@/lib/change-tracking";
import { AiSurfaceConfigSchema } from "@/lib/validation/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROVIDER_KINDS = ["ANTHROPIC", "OPENAI", "GOOGLE", "OLLAMA"] as const;
type ProviderKind = (typeof PROVIDER_KINDS)[number];

const AI_SURFACE_CONFIG_KEY = "aiSurfaceConfig";

// Reused verbatim for the disable guard AND the remove-key guard (D-B8: the
// remove-key rejection carries "the D-B8 message"). Copy is VERBATIM.
const ROUTED_PROVIDER_BLOCK =
  "Assistant uses this provider. Choose another model in Routing defaults before disabling it.";

const PutBodySchema = z.object({
  isEnabled: z.boolean().optional(),
  enabledModels: z.array(z.string().min(1).max(64)).max(50).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  // Absent = NO-OP (never a wipe). A non-empty string replaces the saved key.
  apiKey: z.string().optional(),
  // Explicit removal; transactionally rejected if routing depends on this kind.
  removeKey: z.boolean().optional(),
});

function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

function toModels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : [];
}

/** The set of provider kinds the current routing config references (default +
 *  optional assistant override). Empty when routing is unset/unparseable. */
function routedKinds(rawSetting: string | null | undefined): Set<ProviderKind> {
  if (!rawSetting) return new Set();
  try {
    const config = AiSurfaceConfigSchema.parse(JSON.parse(rawSetting));
    const kinds = new Set<ProviderKind>();
    kinds.add(config.default.providerKind);
    if (config.surfaces?.assistant) kinds.add(config.surfaces.assistant.providerKind);
    return kinds;
  } catch {
    return new Set();
  }
}

/**
 * PUT /api/admin/ai-providers/[kind] — upsert a single provider's config.
 *
 * Key semantics (D-B8): `apiKey` absent = NO-OP (never wipe); a non-empty
 * `apiKey` replaces it; `removeKey:true` clears it but is TRANSACTIONALLY
 * REJECTED if routing currently references this kind. Enabling requires >=1
 * model. Disabling the last-routed provider is blocked inline. All writes emit
 * a diff event (AI_PROVIDER_CREATE on first save of a kind, AI_PROVIDER_UPDATE
 * after); the key value diffs as [REDACTED] via the change-tracking deep scan.
 */
export const PUT = apiHandler(
  async (request: NextRequest, { params }: { params: { kind: string } }) => {
    const { user: adminUser } = await requireAdmin();
    await requireCSRF(request);

    const kindRaw = (params.kind ?? "").toUpperCase();
    if (!isProviderKind(kindRaw)) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
    }
    const kind: ProviderKind = kindRaw;

    const body = PutBodySchema.parse(await request.json());

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.aiProvider.findUnique({ where: { kind } });

      // Effective post-write state used for invariant checks.
      const nextModels =
        body.enabledModels !== undefined ? body.enabledModels : toModels(existing?.enabledModels);
      const nextEnabled =
        body.isEnabled !== undefined ? body.isEnabled : existing?.isEnabled ?? false;
      const nextBaseUrl =
        body.baseUrl !== undefined ? body.baseUrl || null : existing?.baseUrl ?? null;

      // Routing dependency, read INSIDE the tx.
      const routingSetting = await tx.systemSetting.findUnique({
        where: { key: AI_SURFACE_CONFIG_KEY },
        select: { value: true },
      });
      const routed = routedKinds(routingSetting?.value);

      // Disabling the last-routed provider is blocked inline (D-B8).
      if (body.isEnabled === false && existing?.isEnabled && routed.has(kind)) {
        throw new AppError(ROUTED_PROVIDER_BLOCK, "AI_PROVIDER_ROUTED", 400);
      }

      // Enabling requires at least one model (chip-editor invariant, D-B8).
      if (nextEnabled && nextModels.length === 0) {
        throw new AppError(
          "Add at least one model before enabling this provider.",
          "AI_PROVIDER_NO_MODELS",
          400,
        );
      }

      // --- Key handling (order: replace wins over remove; absent = no-op) ---
      let nextKey: string | null | undefined; // undefined => leave untouched
      if (body.apiKey !== undefined && body.apiKey !== "") {
        if (kind === "OLLAMA") {
          throw new AppError("Ollama has no API key", "AI_PROVIDER_INVALID", 400);
        }
        nextKey = encryptValue(body.apiKey);
      } else if (body.removeKey === true) {
        if (routed.has(kind)) {
          throw new AppError(ROUTED_PROVIDER_BLOCK, "AI_PROVIDER_ROUTED", 400);
        }
        nextKey = null;
      } else {
        nextKey = undefined; // no-op
      }

      const beforeKey = existing?.encryptedApiKey ?? null;
      const afterKey = nextKey === undefined ? beforeKey : nextKey;

      const row = await tx.aiProvider.upsert({
        where: { kind },
        create: {
          kind,
          isEnabled: nextEnabled,
          enabledModels: nextModels,
          baseUrl: kind === "OLLAMA" ? nextBaseUrl : null,
          encryptedApiKey: kind === "OLLAMA" ? null : afterKey,
        },
        update: {
          isEnabled: nextEnabled,
          enabledModels: nextModels,
          baseUrl: kind === "OLLAMA" ? nextBaseUrl : null,
          ...(nextKey === undefined ? {} : { encryptedApiKey: kind === "OLLAMA" ? null : nextKey }),
        },
      });

      // --- Diff event -------------------------------------------------------
      const before = {
        isEnabled: existing?.isEnabled ?? false,
        baseUrl: existing?.baseUrl ?? null,
        encryptedApiKey: beforeKey,
      };
      const after = {
        isEnabled: row.isEnabled,
        baseUrl: row.baseUrl ?? null,
        encryptedApiKey: kind === "OLLAMA" ? null : afterKey,
      };
      // diff() auto-redacts `encryptedApiKey` to [REDACTED] on both sides.
      const changes: ChangeDiff = diff(before, after, ["isEnabled", "baseUrl", "encryptedApiKey"]);
      const beforeModels = toModels(existing?.enabledModels);
      if (JSON.stringify(beforeModels) !== JSON.stringify(nextModels)) {
        changes.enabledModels = { from: beforeModels, to: nextModels };
      }

      const isCreate = !existing;
      if (isCreate || Object.keys(changes).length > 0) {
        await recordChange(tx, {
          actor: { userId: adminUser.id },
          actionType: isCreate ? "AI_PROVIDER_CREATE" : "AI_PROVIDER_UPDATE",
          entityType: "SETTINGS",
          entityId: kind,
          action: isCreate ? `Configured ${kind} provider` : `Updated ${kind} provider`,
          changes,
        });
      }

      return row;
    });

    return NextResponse.json({
      provider: {
        kind,
        isEnabled: updated.isEnabled,
        hasKey: !!updated.encryptedApiKey,
        baseUrl: updated.baseUrl ?? null,
        enabledModels: toModels(updated.enabledModels),
        exists: true,
        updatedAt: updated.updatedAt ? updated.updatedAt.toISOString() : null,
      },
    });
  },
);
