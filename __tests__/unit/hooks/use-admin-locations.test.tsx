/** @jest-environment jsdom */
/**
 * Facelift F2-13 (plan 2026-11-19-facelift-f2, REV 2 A1) — the admin create-
 * and delete-location mutations (`hooks/use-admin.ts`) re-read the app-wide
 * location list on success (`useLocation().retryLocations()`), so the chip and
 * every stock writer see the change without a reload. A refused write re-reads
 * nothing. The settings query is still invalidated as before.
 */

import React from "react";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false, error: null }),
  withCSRFHeaders: (headers: Record<string, string>, token: string | null) => ({
    ...headers,
    ...(token ? { "x-csrf-token": token } : {}),
  }),
}));

const mockRetryLocations = jest.fn();
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ retryLocations: mockRetryLocations }),
}));

import { useAddLocation, useDeleteSettingsLocation } from "@/hooks/use-admin";

let client: QueryClient;
function Harness({ children }: { children: ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  global.fetch = mockFetch as unknown as typeof fetch;
});

const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) });
const refusedResponse = () => ({ ok: false, status: 409, json: async () => ({ error: "In use" }) });

describe("F2-13 — the location mutations re-read the location list", () => {
  it("create: success calls retryLocations once, and still invalidates the settings", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useAddLocation(), { wrapper: Harness });

    await act(async () => {
      await result.current.mutateAsync("Backroom");
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/admin/locations", expect.objectContaining({ method: "POST" }));
    expect(mockRetryLocations).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "settings"] });
  });

  it("delete: success calls retryLocations once, and still invalidates the settings", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useDeleteSettingsLocation(), { wrapper: Harness });

    await act(async () => {
      await result.current.mutateAsync(4);
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/admin/locations/4", expect.objectContaining({ method: "DELETE" }));
    expect(mockRetryLocations).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "settings"] });
  });

  it("a refused create or delete re-reads nothing", async () => {
    mockFetch.mockResolvedValue(refusedResponse());
    const add = renderHook(() => useAddLocation(), { wrapper: Harness });
    const del = renderHook(() => useDeleteSettingsLocation(), { wrapper: Harness });

    await act(async () => {
      await add.result.current.mutateAsync("Backroom").catch(() => {});
      await del.result.current.mutateAsync(4).catch(() => {});
    });
    await waitFor(() => expect(add.result.current.isError).toBe(true));
    await waitFor(() => expect(del.result.current.isError).toBe(true));

    expect(mockRetryLocations).not.toHaveBeenCalled();
  });
});
