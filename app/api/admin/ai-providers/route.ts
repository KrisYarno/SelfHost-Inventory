import { NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The four provider kinds always render as panels (D-B7: all four kinds always
// render). Ordered for a stable UI. Kept local so this route never imports the
// ESM `lib/assistant/providers` module (which pulls the AI SDK).
const PROVIDER_KINDS = ["ANTHROPIC", "OPENAI", "GOOGLE", "OLLAMA"] as const;
type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Non-secret projection of an `ai_providers` row. NEVER carries key material —
 *  only `hasKey` (D3/D-B8: GET returns hasKey only). */
export interface ProviderView {
  kind: ProviderKind;
  isEnabled: boolean;
  hasKey: boolean;
  baseUrl: string | null;
  enabledModels: string[];
  exists: boolean;
  updatedAt: string | null;
}

function toModels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : [];
}

/**
 * GET /api/admin/ai-providers — the four provider kinds, each projected to its
 * non-secret fields plus a `hasKey` boolean. Absent kinds synthesize a blank,
 * disabled panel so the admin surface always renders all four (D-B7).
 */
export const GET = apiHandler(async () => {
  await requireAdmin();

  const rows = await prisma.aiProvider.findMany();
  const byKind = new Map(rows.map((r) => [r.kind, r]));

  const providers: ProviderView[] = PROVIDER_KINDS.map((kind) => {
    const row = byKind.get(kind);
    if (!row) {
      return {
        kind,
        isEnabled: false,
        hasKey: false,
        baseUrl: null,
        enabledModels: [],
        exists: false,
        updatedAt: null,
      };
    }
    return {
      kind,
      isEnabled: row.isEnabled,
      hasKey: !!row.encryptedApiKey,
      baseUrl: row.baseUrl ?? null,
      enabledModels: toModels(row.enabledModels),
      exists: true,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });

  return NextResponse.json({ providers });
});
