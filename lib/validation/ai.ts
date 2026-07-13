/**
 * lib/validation/ai.ts — the surface-routing config schema + transactional
 * invariant validation (spec D2, codex #7). TRUNK-owned; the T4 admin routing PUT
 * consumes `AiSurfaceConfigSchema` + `validateSurfaceConfig`.
 *
 * MUST stay Next-free (reached from lib/assistant/providers.ts): only zod, the
 * Prisma namespace (for TransactionClient), and AppError.
 */

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { AppError } from "@/lib/error-handling";
import type { ProviderKind } from "@/lib/assistant/providers";

const providerKindSchema = z.enum(["ANTHROPIC", "OPENAI", "GOOGLE", "OLLAMA"]);

const providerRefSchema = z.object({
  providerKind: providerKindSchema,
  model: z.string().min(1).max(64),
});

export type AiSurfaceConfig = {
  default: { providerKind: ProviderKind; model: string };
  surfaces?: { assistant?: { providerKind: ProviderKind; model: string } };
};

export const AiSurfaceConfigSchema: z.ZodType<AiSurfaceConfig> = z.object({
  default: providerRefSchema,
  surfaces: z.object({ assistant: providerRefSchema.optional() }).optional(),
});

/**
 * Validate a proposed surface config against the CURRENT provider rows, inside the
 * caller's transaction (D2 invariants): every referenced provider row exists, is
 * enabled, has its credential/endpoint, and lists the referenced model in
 * `enabledModels`. Throws AppError(400) on the first violation.
 */
export async function validateSurfaceConfig(
  tx: Prisma.TransactionClient,
  next: AiSurfaceConfig,
): Promise<void> {
  const refs = [next.default, ...(next.surfaces?.assistant ? [next.surfaces.assistant] : [])];
  for (const ref of refs) {
    const provider = await tx.aiProvider.findUnique({ where: { kind: ref.providerKind } });
    if (!provider) {
      throw new AppError(`Provider ${ref.providerKind} is not configured`, "AI_CONFIG_INVALID", 400);
    }
    if (!provider.isEnabled) {
      throw new AppError(`Provider ${ref.providerKind} is disabled`, "AI_CONFIG_INVALID", 400);
    }
    const hasCredential =
      ref.providerKind === "OLLAMA" ? !!provider.baseUrl : !!provider.encryptedApiKey;
    if (!hasCredential) {
      const missing = ref.providerKind === "OLLAMA" ? "endpoint" : "key";
      throw new AppError(`Provider ${ref.providerKind} is missing its ${missing}`, "AI_CONFIG_INVALID", 400);
    }
    const enabled = Array.isArray(provider.enabledModels)
      ? (provider.enabledModels as unknown[])
      : [];
    if (!enabled.includes(ref.model)) {
      throw new AppError(`Model ${ref.model} is not enabled for ${ref.providerKind}`, "AI_CONFIG_INVALID", 400);
    }
  }
}
