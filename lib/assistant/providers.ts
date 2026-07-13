/**
 * lib/assistant/providers.ts — per-request provider registry + surface resolution
 * (spec D2, §11 spike). Providers are constructed FRESH per request from decrypted
 * `ai_providers` rows (no network on construction); resolution failure degrades to
 * the assistant's provider-unconfigured state (AppError 409), never a crash.
 *
 * MUST stay Next-free.
 */

import { createProviderRegistry, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ai-sdk-ollama";
import prisma from "@/lib/prisma";
import { decryptValue } from "@/lib/encryption";
import { AppError } from "@/lib/error-handling";
import { AiSurfaceConfigSchema, type AiSurfaceConfig } from "@/lib/validation/ai";

export type ProviderKind = "ANTHROPIC" | "OPENAI" | "GOOGLE" | "OLLAMA";

export interface ResolvedModel {
  kind: ProviderKind;
  model: string;
  languageModel: LanguageModel;
}

export const PROVIDER_TIMEOUT_MS = 60_000;

const AI_SURFACE_CONFIG_KEY = "aiSurfaceConfig";

type ProviderRow = { encryptedApiKey: string | null; baseUrl: string | null };

/** The single provider-unconfigured signal. THAT argument order (codex #3):
 *  AppError(message, code, statusCode). */
function unconfigured(): never {
  throw new AppError("Assistant is not configured", "AI_UNCONFIGURED", 409);
}

/**
 * Resolve the concrete provider + model + languageModel for a surface. Reads the
 * `aiSurfaceConfig` setting, picks the surface override or the default, verifies the
 * provider row is enabled with its credential and lists the model, then builds the
 * languageModel via a per-request registry. Any gap -> AppError('AI_UNCONFIGURED').
 */
export async function resolveSurfaceModel(surface: "assistant"): Promise<ResolvedModel> {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: AI_SURFACE_CONFIG_KEY },
    select: { value: true },
  });
  if (!setting) return unconfigured();

  let config: AiSurfaceConfig;
  try {
    config = AiSurfaceConfigSchema.parse(JSON.parse(setting.value));
  } catch {
    return unconfigured();
  }

  const ref = config.surfaces?.[surface] ?? config.default;

  const provider = await prisma.aiProvider.findUnique({ where: { kind: ref.providerKind } });
  if (!provider || !provider.isEnabled) return unconfigured();

  const enabled = Array.isArray(provider.enabledModels)
    ? (provider.enabledModels as unknown[])
    : [];
  if (!enabled.includes(ref.model)) return unconfigured();

  const languageModel = buildLanguageModel(ref.providerKind, ref.model, provider);
  return { kind: ref.providerKind, model: ref.model, languageModel };
}

/** Build a fresh registry for the resolved provider and return its languageModel.
 *  The registry is constructed per call (never at module scope). */
function buildLanguageModel(kind: ProviderKind, model: string, provider: ProviderRow): LanguageModel {
  const providerId = kind.toLowerCase();
  try {
    const built = buildProvider(kind, provider);
    const registry = createProviderRegistry({ [providerId]: built });
    // The registry types the id as a `${string}:${string}` template literal; a
    // runtime DB string needs the assertion (spike note).
    return registry.languageModel(`${providerId}:${model}` as `${string}:${string}`);
  } catch {
    return unconfigured();
  }
}

function buildProvider(kind: ProviderKind, provider: ProviderRow) {
  switch (kind) {
    case "ANTHROPIC":
      return createAnthropic({ apiKey: requireKey(provider.encryptedApiKey) });
    case "OPENAI":
      return createOpenAI({ apiKey: requireKey(provider.encryptedApiKey) });
    case "GOOGLE":
      return createGoogleGenerativeAI({ apiKey: requireKey(provider.encryptedApiKey) });
    case "OLLAMA":
      return createOllama({ baseURL: provider.baseUrl ?? undefined });
  }
}

function requireKey(encrypted: string | null): string {
  if (!encrypted) return unconfigured();
  return decryptValue(encrypted);
}
