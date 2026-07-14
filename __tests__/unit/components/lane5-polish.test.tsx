/**
 * @jest-environment jsdom
 *
 * Lane 5 (L-POLISH) — U3: the admin AI Selects must be CONTROLLED from first
 * render. Passing `value={x || undefined}` let the value flip from undefined
 * (uncontrolled) to a string (controlled) once state/data settled — React logs a
 * controlled/uncontrolled console.error on the Select's hidden native element.
 * The empty-string sentinel (`value={x ?? ""}`) keeps them controlled throughout.
 *
 * These tests assert NO controlled/uncontrolled warning fires across the real
 * lifecycle flips (owner list loading async; provider/model mount).
 */
import React from "react";
import { render } from "@testing-library/react";

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const useSessionMock = jest.fn(() => ({ data: { user: { email: "admin@e.com" } } }));
jest.mock("next-auth/react", () => ({ useSession: () => useSessionMock() }));

// Keep the real consts/types; stub the data hooks + mutations.
const mockSaveRoutingMutate = jest.fn();
const mockCreateTokenMutate = jest.fn();
const mockRevokeTokenMutate = jest.fn();
let mockTokensData: unknown;

jest.mock("@/hooks/use-ai-admin", () => {
  const actual = jest.requireActual("@/hooks/use-ai-admin");
  return {
    __esModule: true,
    ...actual,
    useApiTokens: () => ({ data: mockTokensData, isLoading: false }),
    useSaveRouting: () => ({ mutateAsync: mockSaveRoutingMutate, isPending: false }),
    useCreateToken: () => ({ mutateAsync: mockCreateTokenMutate, isPending: false }),
    useRevokeToken: () => ({ mutateAsync: mockRevokeTokenMutate, isPending: false }),
  };
});

import { RoutingDefaults } from "@/components/admin/ai/routing-defaults";
import { TokenSection } from "@/components/admin/ai/token-section";
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

describe("U3: AI settings Selects are controlled from first render", () => {
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  function controlledWarnings(): unknown[] {
    return errSpy.mock.calls.filter((c) =>
      /uncontrolled|to be controlled|changing an?.*controlled/i.test(String(c[0])),
    );
  }

  test("TokenSection owner Select survives an async owner-list load with no controlled flip", () => {
    // First paint: owners not loaded (preselectId === "") — controlled empty.
    mockTokensData = undefined;
    const { rerender } = render(<TokenSection />);
    // Owners arrive: preselectId becomes a real id — still a controlled string.
    mockTokensData = { tokens: [], owners: [{ id: 7, username: "admin", email: "admin@e.com" }] };
    rerender(<TokenSection />);

    expect(controlledWarnings()).toEqual([]);
  });

  test("RoutingDefaults provider + model Selects mount controlled (no undefined value)", () => {
    // A selectable provider with no configured model: kind is set, model === "".
    render(
      <RoutingDefaults
        providers={[provider({ kind: "ANTHROPIC", isEnabled: true, hasKey: true, enabledModels: ["m1"] })]}
        routing={{ config: null, resolved: null }}
      />,
    );
    expect(controlledWarnings()).toEqual([]);
  });
});
