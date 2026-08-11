/**
 * @jest-environment node
 *
 * Task 2.3 unit contracts for `lib/validation/ai.ts` (spec C6; contract pack T6):
 * the surface-routing config gains an OPTIONAL `surfaces.title` ref, and the D2
 * invariant check treats it exactly like the assistant ref — a title route may not
 * point at a provider that is missing, disabled, credential-less or does not list
 * the model.
 *
 * Panel UI does not expose title routing in v1 (spec C6): the schema + the PUT
 * /routing endpoint ARE the surface, which makes the schema round-trip below the
 * only thing standing between an API-set title route and silent key-stripping —
 * `z.object` drops unknown keys, so an unwidened schema would erase the field on
 * every parse.
 */

import { Prisma } from "@prisma/client";
import { AiSurfaceConfigSchema, validateSurfaceConfig } from "@/lib/validation/ai";
import { AppError } from "@/lib/error-handling";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_REF = { providerKind: "ANTHROPIC" as const, model: "claude-sonnet-4-5" };
const TITLE_REF = { providerKind: "OLLAMA" as const, model: "llama3.2" };

function tx(rows: Record<string, unknown>): Prisma.TransactionClient {
  return {
    aiProvider: {
      findUnique: jest.fn(async ({ where }: any) => rows[where.kind] ?? null),
    },
  } as unknown as Prisma.TransactionClient;
}

function provider(over: Record<string, unknown> = {}) {
  return {
    kind: "ANTHROPIC",
    isEnabled: true,
    encryptedApiKey: "enc",
    baseUrl: null,
    enabledModels: ["claude-sonnet-4-5"],
    ...over,
  };
}

const OLLAMA_OK = provider({
  kind: "OLLAMA",
  encryptedApiKey: null,
  baseUrl: "http://ollama:11434",
  enabledModels: ["llama3.2"],
});

describe("AiSurfaceConfigSchema: surfaces.title round-trips (C6)", () => {
  it("preserves a title ref through parse (an unwidened z.object would strip it)", () => {
    const config = {
      default: DEFAULT_REF,
      surfaces: { assistant: DEFAULT_REF, title: TITLE_REF },
    };

    const parsed = AiSurfaceConfigSchema.parse(config);

    expect(parsed.surfaces?.title).toEqual(TITLE_REF);
    // Round-trip through storage (the setting is a JSON string) is byte-identical.
    expect(AiSurfaceConfigSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(config);
  });

  it("keeps title OPTIONAL — every config written before this task still parses", () => {
    const legacy = { default: DEFAULT_REF, surfaces: { assistant: DEFAULT_REF } };

    const parsed = AiSurfaceConfigSchema.parse(legacy);

    expect(parsed.surfaces?.title).toBeUndefined();
    expect(AiSurfaceConfigSchema.parse({ default: DEFAULT_REF }).surfaces).toBeUndefined();
  });

  it("rejects a malformed title ref (same providerRefSchema as every other ref)", () => {
    expect(() =>
      AiSurfaceConfigSchema.parse({
        default: DEFAULT_REF,
        surfaces: { title: { providerKind: "NOPE", model: "x" } },
      }),
    ).toThrow();
    expect(() =>
      AiSurfaceConfigSchema.parse({
        default: DEFAULT_REF,
        surfaces: { title: { providerKind: "OLLAMA", model: "" } },
      }),
    ).toThrow();
  });
});

describe("validateSurfaceConfig: the title ref is validated like any other (D2)", () => {
  it("accepts a title ref whose provider exists, is enabled and lists the model", async () => {
    const client = tx({ ANTHROPIC: provider(), OLLAMA: OLLAMA_OK });

    await expect(
      validateSurfaceConfig(client, {
        default: DEFAULT_REF,
        surfaces: { title: TITLE_REF },
      }),
    ).resolves.toBeUndefined();
    // Positive control: acceptance means the title provider WAS looked up, not that
    // the ref was skipped.
    const lookedUp = (client.aiProvider.findUnique as jest.Mock).mock.calls.map(
      ([args]) => args.where.kind,
    );
    expect(lookedUp).toContain("OLLAMA");
  });

  it("rejects a title ref to a provider that is not configured (400)", async () => {
    const client = tx({ ANTHROPIC: provider() });

    await expect(
      validateSurfaceConfig(client, { default: DEFAULT_REF, surfaces: { title: TITLE_REF } }),
    ).rejects.toMatchObject({ code: "AI_CONFIG_INVALID", statusCode: 400 });
  });

  it("rejects a title ref to a DISABLED provider (400)", async () => {
    const client = tx({ ANTHROPIC: provider(), OLLAMA: { ...OLLAMA_OK, isEnabled: false } });

    let caught: unknown;
    try {
      await validateSurfaceConfig(client, { default: DEFAULT_REF, surfaces: { title: TITLE_REF } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toContain("disabled");
  });

  it("rejects a title ref to a provider missing its credential/endpoint (400)", async () => {
    const client = tx({ ANTHROPIC: provider(), OLLAMA: { ...OLLAMA_OK, baseUrl: null } });

    await expect(
      validateSurfaceConfig(client, { default: DEFAULT_REF, surfaces: { title: TITLE_REF } }),
    ).rejects.toMatchObject({ code: "AI_CONFIG_INVALID", statusCode: 400 });
  });

  it("rejects a title ref to a model the provider does not list (400)", async () => {
    const client = tx({ ANTHROPIC: provider(), OLLAMA: { ...OLLAMA_OK, enabledModels: ["other"] } });

    await expect(
      validateSurfaceConfig(client, { default: DEFAULT_REF, surfaces: { title: TITLE_REF } }),
    ).rejects.toMatchObject({ code: "AI_CONFIG_INVALID", statusCode: 400 });
  });

  it("still validates default and assistant alongside title (no ref is skipped)", async () => {
    const client = tx({ ANTHROPIC: provider({ enabledModels: [] }), OLLAMA: OLLAMA_OK });

    await expect(
      validateSurfaceConfig(client, {
        default: DEFAULT_REF,
        surfaces: { assistant: DEFAULT_REF, title: TITLE_REF },
      }),
    ).rejects.toMatchObject({ code: "AI_CONFIG_INVALID" });
  });
});
