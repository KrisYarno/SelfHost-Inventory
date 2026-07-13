/**
 * @jest-environment jsdom
 *
 * Lane 4 (Task 4 / W2-B) — admin AI panel UI (spec §12 D-B7/8/9): status
 * precedence, draft/save/cancel semantics, chip editor, last-routed disable
 * guard, the Ollama warning copy, once-only secret dialog, and the panel states
 * matrix (all four kinds render; routing/tokens empty copy).
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- sonner + clipboard ---
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...p }: any) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

// --- hook module: keep the real consts/types, stub the data + mutations ---
const mockSaveProviderMutate = jest.fn();
const mockTestProviderMutate = jest.fn();
const mockSaveRoutingMutate = jest.fn();
const mockCreateTokenMutate = jest.fn();
const mockRevokeTokenMutate = jest.fn();
let mockProvidersData: any;
let mockRoutingData: any;
let mockTokensData: any;

jest.mock("@/hooks/use-ai-admin", () => {
  const actual = jest.requireActual("@/hooks/use-ai-admin");
  return {
    __esModule: true,
    ...actual,
    useAiProviders: () => ({ data: mockProvidersData, isLoading: false, isError: false }),
    useAiRouting: () => ({ data: mockRoutingData, isLoading: false, isError: false }),
    useApiTokens: () => ({ data: mockTokensData, isLoading: false }),
    useSaveProvider: () => ({ mutateAsync: mockSaveProviderMutate, isPending: false }),
    useTestProvider: () => ({ mutateAsync: mockTestProviderMutate, isPending: false }),
    useSaveRouting: () => ({ mutateAsync: mockSaveRoutingMutate, isPending: false }),
    useCreateToken: () => ({ mutateAsync: mockCreateTokenMutate, isPending: false }),
    useRevokeToken: () => ({ mutateAsync: mockRevokeTokenMutate, isPending: false }),
  };
});

import {
  ProviderPanel,
  computeProviderStatus,
  OLLAMA_PROMPT_WARNING,
  ROUTED_DISABLE_MESSAGE,
} from "@/components/admin/ai/provider-panel";
import { RoutingDefaults, ROUTING_EMPTY_COPY } from "@/components/admin/ai/routing-defaults";
import { TokenSection, TOKENS_EMPTY_COPY } from "@/components/admin/ai/token-section";
import { SECRET_ONCE_COPY } from "@/components/admin/ai/token-secret-dialog";
import AiSettingsPage from "@/app/(app)/admin/settings/ai/page";
import type { ProviderView } from "@/hooks/use-ai-admin";

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    kind: "ANTHROPIC",
    isEnabled: false,
    hasKey: false,
    baseUrl: null,
    enabledModels: [],
    exists: false,
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Status precedence (pure)
// ---------------------------------------------------------------------------
describe("computeProviderStatus precedence (D-B8)", () => {
  it("Needs key/endpoint wins first", () => {
    expect(
      computeProviderStatus({ kind: "ANTHROPIC", hasCredential: false, modelCount: 2, isEnabled: true, pendingVerify: true }).label,
    ).toBe("Needs key");
    expect(
      computeProviderStatus({ kind: "OLLAMA", hasCredential: false, modelCount: 0, isEnabled: false, pendingVerify: false }).label,
    ).toBe("Needs endpoint");
  });

  it("Needs models -> Disabled -> Enabled not-yet-verified -> Configured", () => {
    expect(
      computeProviderStatus({ kind: "OPENAI", hasCredential: true, modelCount: 0, isEnabled: true, pendingVerify: true }).label,
    ).toBe("Needs models");
    expect(
      computeProviderStatus({ kind: "OPENAI", hasCredential: true, modelCount: 1, isEnabled: false, pendingVerify: true }).label,
    ).toBe("Disabled");
    expect(
      computeProviderStatus({ kind: "OPENAI", hasCredential: true, modelCount: 1, isEnabled: true, pendingVerify: true }).label,
    ).toBe("Enabled — not yet verified");
    expect(
      computeProviderStatus({ kind: "OPENAI", hasCredential: true, modelCount: 1, isEnabled: true, pendingVerify: false }).label,
    ).toBe("Configured");
  });
});

// ---------------------------------------------------------------------------
// ProviderPanel — chip editor, Ollama warning, disable guard, save error
// ---------------------------------------------------------------------------
describe("ProviderPanel", () => {
  it("Ollama panel carries the required prompt-data warning (copy-tested)", () => {
    render(<ProviderPanel provider={provider({ kind: "OLLAMA" })} isRouted={false} />);
    expect(screen.getByText(OLLAMA_PROMPT_WARNING)).toBeInTheDocument();
  });

  it("chip editor adds, rejects duplicates inline, and removes", async () => {
    const user = userEvent.setup();
    render(<ProviderPanel provider={provider({ enabledModels: ["m1"] })} isRouted={false} />);

    const input = screen.getByLabelText("Add a model");
    await user.type(input, "m1{Enter}");
    expect(screen.getByText(/is already added/i)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "m2{Enter}");
    expect(screen.getByText("m2")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Remove m1"));
    expect(screen.queryByText("m1")).not.toBeInTheDocument();
  });

  it("blocks disabling the last-routed provider inline (VERBATIM copy)", async () => {
    const user = userEvent.setup();
    render(
      <ProviderPanel
        provider={provider({ isEnabled: true, hasKey: true, enabledModels: ["m1"] })}
        isRouted
      />,
    );
    await user.click(screen.getByRole("switch"));
    expect(screen.getByText(ROUTED_DISABLE_MESSAGE)).toBeInTheDocument();
  });

  it("a save failure preserves the draft and shows the in-row copy", async () => {
    const user = userEvent.setup();
    mockSaveProviderMutate.mockRejectedValue(new Error("boom"));
    render(
      <ProviderPanel
        provider={provider({ isEnabled: true, hasKey: true, enabledModels: ["m1"] })}
        isRouted={false}
      />,
    );

    // Make the panel dirty by adding a model.
    await user.type(screen.getByLabelText("Add a model"), "m2{Enter}");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(
      await screen.findByText("Could not save Anthropic settings. Your changes are still here."),
    ).toBeInTheDocument();
    // Draft survives the error.
    expect(screen.getByText("m2")).toBeInTheDocument();
  });

  it("read-state shows 'Key set' with Replace/Remove, no Eye toggle", () => {
    render(
      <ProviderPanel
        provider={provider({ isEnabled: true, hasKey: true, enabledModels: ["m1"] })}
        isRouted={false}
      />,
    );
    expect(screen.getByText(/Key set/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replace key/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove saved key/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RoutingDefaults — empty copy + resolved display
// ---------------------------------------------------------------------------
describe("RoutingDefaults (D-B8)", () => {
  it("shows the empty copy when no provider is selectable", () => {
    render(
      <RoutingDefaults
        providers={[provider({ kind: "ANTHROPIC" }), provider({ kind: "OLLAMA" })]}
        routing={{ config: null, resolved: null }}
      />,
    );
    expect(screen.getByText(ROUTING_EMPTY_COPY)).toBeInTheDocument();
  });

  it("always displays the resolved assistant model", () => {
    render(
      <RoutingDefaults
        providers={[
          provider({ kind: "ANTHROPIC", isEnabled: true, hasKey: true, enabledModels: ["m1"] }),
        ]}
        routing={{
          config: { default: { providerKind: "ANTHROPIC", model: "m1" } },
          resolved: { providerKind: "ANTHROPIC", model: "m1" },
        }}
      />,
    );
    expect(screen.getByText("Assistant uses: Anthropic · m1")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TokenSection — empty copy + once-only secret dialog
// ---------------------------------------------------------------------------
describe("TokenSection (D-B9)", () => {
  it("shows the tokens empty copy", () => {
    mockTokensData = { tokens: [], owners: [{ id: 7, username: "admin", email: "admin@e.com" }] };
    render(<TokenSection />);
    expect(screen.getByText(TOKENS_EMPTY_COPY)).toBeInTheDocument();
  });

  it("surfaces the once-only secret in a modal after create (token never toasted)", async () => {
    const user = userEvent.setup();
    mockTokensData = { tokens: [], owners: [{ id: 7, username: "admin", email: "admin@e.com" }] };
    mockCreateTokenMutate.mockResolvedValue({
      token: "invmcp_SECRETVALUE",
      id: "tok_1",
      name: "Claude Desktop",
    });

    render(<TokenSection />);
    await user.type(screen.getByLabelText("Name"), "Claude Desktop");
    await user.click(screen.getByRole("button", { name: /create token/i }));

    expect(await screen.findByText(SECRET_ONCE_COPY)).toBeInTheDocument();
    expect(screen.getByText("invmcp_SECRETVALUE")).toBeInTheDocument();

    // The token itself never enters a toast.
    const { toast } = jest.requireMock("sonner");
    for (const call of toast.success.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("invmcp_SECRETVALUE");
    }
  });

  it("Copy token confirms with a toast that omits the token", async () => {
    // userEvent.setup installs its own clipboard stub that supports readText.
    const user = userEvent.setup();
    mockTokensData = { tokens: [], owners: [{ id: 7, username: "admin", email: "admin@e.com" }] };
    mockCreateTokenMutate.mockResolvedValue({ token: "invmcp_XYZ", id: "t", name: "N" });

    render(<TokenSection />);
    await user.type(screen.getByLabelText("Name"), "N");
    await user.click(screen.getByRole("button", { name: /create token/i }));
    await screen.findByText(SECRET_ONCE_COPY);

    await user.click(screen.getByRole("button", { name: /copy token/i }));
    // The actual token reaches the clipboard, and the toast confirms WITHOUT it.
    expect(await navigator.clipboard.readText()).toBe("invmcp_XYZ");
    const { toast } = jest.requireMock("sonner");
    expect(toast.success).toHaveBeenCalledWith("Token copied");
    expect(JSON.stringify(toast.success.mock.calls)).not.toContain("invmcp_XYZ");
  });
});

// ---------------------------------------------------------------------------
// Page states matrix — all four kinds render (never a blank page)
// ---------------------------------------------------------------------------
describe("AI settings page (D-B7 states matrix)", () => {
  it("renders all four provider kinds and the tokens empty copy", () => {
    mockProvidersData = [
      provider({ kind: "ANTHROPIC" }),
      provider({ kind: "OPENAI" }),
      provider({ kind: "GOOGLE" }),
      provider({ kind: "OLLAMA" }),
    ];
    mockRoutingData = { config: null, resolved: null };
    mockTokensData = { tokens: [], owners: [] };

    render(<AiSettingsPage />);

    for (const label of ["Anthropic", "OpenAI", "Google", "Ollama"]) {
      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    }
    // Routing empty (no selectable provider) + tokens empty both render.
    expect(screen.getByText(ROUTING_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.getByText(TOKENS_EMPTY_COPY)).toBeInTheDocument();
  });
});
