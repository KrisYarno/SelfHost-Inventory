/**
 * @jest-environment node
 *
 * Lane 4 trunk contract: provider resolution (lib/assistant/providers.ts).
 * Covers the provider-unconfigured signal (AppError with THAT argument order),
 * the D2 invariant checks at resolution time, and per-REQUEST registry construction.
 *
 * The AI SDK + provider factories are mocked so the ESM-only packages never load and
 * so we can assert the registry is built fresh per call. prisma + encryption mocked.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

const mockLanguageModel = jest.fn(() => ({ __mock: "languageModel" }));
const mockCreateProviderRegistry = jest.fn(() => ({ languageModel: mockLanguageModel }));

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});
jest.mock("ai", () => ({
  __esModule: true,
  createProviderRegistry: (...args: unknown[]) => mockCreateProviderRegistry(...(args as [])),
}));
jest.mock("@ai-sdk/anthropic", () => ({ __esModule: true, createAnthropic: jest.fn(() => ({ id: "anthropic" })) }));
jest.mock("@ai-sdk/openai", () => ({ __esModule: true, createOpenAI: jest.fn(() => ({ id: "openai" })) }));
jest.mock("@ai-sdk/google", () => ({ __esModule: true, createGoogleGenerativeAI: jest.fn(() => ({ id: "google" })) }));
jest.mock("ai-sdk-ollama", () => ({ __esModule: true, createOllama: jest.fn(() => ({ id: "ollama" })) }));
jest.mock("@/lib/encryption", () => ({ __esModule: true, decryptValue: jest.fn(() => "decrypted-key") }));

import prisma from "@/lib/prisma";
import { resolveSurfaceModel, PROVIDER_TIMEOUT_MS } from "@/lib/assistant/providers";
import { AppError } from "@/lib/error-handling";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

function configRow(config: unknown) {
  return { value: JSON.stringify(config) } as never;
}

const VALID_CONFIG = { default: { providerKind: "ANTHROPIC", model: "claude-sonnet-4-5" } };

function providerRow(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    kind: "ANTHROPIC",
    isEnabled: true,
    encryptedApiKey: "enc",
    baseUrl: null,
    enabledModels: ["claude-sonnet-4-5"],
    ...over,
  } as never;
}

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
});

describe("resolveSurfaceModel: unconfigured signal", () => {
  it("throws AppError('Assistant is not configured','AI_UNCONFIGURED',409) when no config exists", async () => {
    db.systemSetting.findUnique.mockResolvedValue(null as never);

    await expect(resolveSurfaceModel("assistant")).rejects.toMatchObject({
      message: "Assistant is not configured",
      code: "AI_UNCONFIGURED",
      statusCode: 409,
    });

    let caught: unknown;
    db.systemSetting.findUnique.mockResolvedValue(null as never);
    try {
      await resolveSurfaceModel("assistant");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
  });

  it("degrades to unconfigured when the stored config JSON is malformed", async () => {
    db.systemSetting.findUnique.mockResolvedValue({ value: "not json{" } as never);
    await expect(resolveSurfaceModel("assistant")).rejects.toMatchObject({ code: "AI_UNCONFIGURED" });
  });
});

describe("resolveSurfaceModel: D2 invariant checks at resolution", () => {
  it("unconfigured when the referenced provider is disabled", async () => {
    db.systemSetting.findUnique.mockResolvedValue(configRow(VALID_CONFIG));
    db.aiProvider.findUnique.mockResolvedValue(providerRow({ isEnabled: false }));
    await expect(resolveSurfaceModel("assistant")).rejects.toMatchObject({ code: "AI_UNCONFIGURED" });
    expect(mockCreateProviderRegistry).not.toHaveBeenCalled();
  });

  it("unconfigured when the routed model is not in enabledModels", async () => {
    db.systemSetting.findUnique.mockResolvedValue(configRow(VALID_CONFIG));
    db.aiProvider.findUnique.mockResolvedValue(providerRow({ enabledModels: ["some-other-model"] }));
    await expect(resolveSurfaceModel("assistant")).rejects.toMatchObject({ code: "AI_UNCONFIGURED" });
  });
});

describe("resolveSurfaceModel: happy path + per-request registry", () => {
  it("resolves the model and builds the registry FRESH on every call", async () => {
    db.systemSetting.findUnique.mockResolvedValue(configRow(VALID_CONFIG));
    db.aiProvider.findUnique.mockResolvedValue(providerRow());

    const r1 = await resolveSurfaceModel("assistant");
    expect(r1.kind).toBe("ANTHROPIC");
    expect(r1.model).toBe("claude-sonnet-4-5");
    expect(r1.languageModel).toBeDefined();

    await resolveSurfaceModel("assistant");

    // Built per request, never at module scope.
    expect(mockCreateProviderRegistry).toHaveBeenCalledTimes(2);
    // Resolves an `anthropic:<model>` id from the per-request registry.
    expect(mockLanguageModel).toHaveBeenCalledWith("anthropic:claude-sonnet-4-5");
  });

  it("prefers the surface override over the default when present", async () => {
    db.systemSetting.findUnique.mockResolvedValue(
      configRow({
        default: { providerKind: "ANTHROPIC", model: "claude-sonnet-4-5" },
        surfaces: { assistant: { providerKind: "OPENAI", model: "gpt-x" } },
      }),
    );
    db.aiProvider.findUnique.mockResolvedValue(
      providerRow({ kind: "OPENAI", encryptedApiKey: "enc", enabledModels: ["gpt-x"] }),
    );

    const r = await resolveSurfaceModel("assistant");
    expect(r.kind).toBe("OPENAI");
    expect(r.model).toBe("gpt-x");
    expect(mockLanguageModel).toHaveBeenCalledWith("openai:gpt-x");
  });

  it("exposes the per-request provider timeout constant", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(60_000);
  });
});

// Task 2.3 (spec C6): the surface union widens to "assistant" | "title", and title
// resolution is a CHAIN — its own override, else the assistant override, else the
// default. Routing the assistant somewhere routes its titles there too unless the
// title surface is explicitly set (API-only in v1).
describe("resolveSurfaceModel: the title surface (C6)", () => {
  it("prefers an explicit title override", async () => {
    db.systemSetting.findUnique.mockResolvedValue(
      configRow({
        default: { providerKind: "ANTHROPIC", model: "claude-sonnet-4-5" },
        surfaces: {
          assistant: { providerKind: "OPENAI", model: "gpt-x" },
          title: { providerKind: "OLLAMA", model: "llama3.2" },
        },
      }),
    );
    db.aiProvider.findUnique.mockResolvedValue(
      providerRow({
        kind: "OLLAMA",
        encryptedApiKey: null,
        baseUrl: "http://ollama:11434",
        enabledModels: ["llama3.2"],
      }),
    );

    const r = await resolveSurfaceModel("title");
    expect({ kind: r.kind, model: r.model }).toEqual({ kind: "OLLAMA", model: "llama3.2" });
    expect(mockLanguageModel).toHaveBeenCalledWith("ollama:llama3.2");
  });

  it("falls back THROUGH the assistant override when no title override exists", async () => {
    db.systemSetting.findUnique.mockResolvedValue(
      configRow({
        default: { providerKind: "ANTHROPIC", model: "claude-sonnet-4-5" },
        surfaces: { assistant: { providerKind: "OPENAI", model: "gpt-x" } },
      }),
    );
    db.aiProvider.findUnique.mockResolvedValue(
      providerRow({ kind: "OPENAI", encryptedApiKey: "enc", enabledModels: ["gpt-x"] }),
    );

    const r = await resolveSurfaceModel("title");
    expect({ kind: r.kind, model: r.model }).toEqual({ kind: "OPENAI", model: "gpt-x" });
  });

  it("falls back to the default when there are no surface overrides at all", async () => {
    db.systemSetting.findUnique.mockResolvedValue(configRow(VALID_CONFIG));
    db.aiProvider.findUnique.mockResolvedValue(providerRow());

    const r = await resolveSurfaceModel("title");
    expect({ kind: r.kind, model: r.model }).toEqual({
      kind: "ANTHROPIC",
      model: "claude-sonnet-4-5",
    });
  });

  it("degrades to AI_UNCONFIGURED when the title-routed provider is disabled", async () => {
    db.systemSetting.findUnique.mockResolvedValue(
      configRow({
        default: { providerKind: "ANTHROPIC", model: "claude-sonnet-4-5" },
        surfaces: { title: { providerKind: "OLLAMA", model: "llama3.2" } },
      }),
    );
    db.aiProvider.findUnique.mockResolvedValue(
      providerRow({ kind: "OLLAMA", isEnabled: false, enabledModels: ["llama3.2"] }),
    );

    await expect(resolveSurfaceModel("title")).rejects.toMatchObject({ code: "AI_UNCONFIGURED" });
  });
});
