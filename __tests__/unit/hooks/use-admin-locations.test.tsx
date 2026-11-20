/** @jest-environment jsdom */
/**
 * Facelift F2-13 (plan 2026-11-19-facelift-f2, REV 2 A1) — the admin create-
 * and delete-location mutations (`hooks/use-admin.ts`) re-read the app-wide
 * location list on success (`useLocation().retryLocations()`), so the chip and
 * every stock writer see the change without a reload. A refused write re-reads
 * nothing. The settings query is still invalidated as before.
 *
 * Fix round FR1-4 (REV 7): they ALSO invalidate the cached location lists —
 * `useLocations`' `locationKeys.all` (`["locations"]`) and the admin
 * `["admin", "location-options"]` — so every location list refreshes. The
 * shared list is invalidated through `use-locations`' own
 * `invalidateLocationLists` (orchestrator ruling on FR1 S1), so that module
 * stays the one owner of its key (use-locations.test's ownership pin).
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

// The real module, with its invalidate helper wrapped so a call can be counted.
jest.mock("@/hooks/use-locations", () => {
  const actual = jest.requireActual("@/hooks/use-locations");
  return {
    ...actual,
    invalidateLocationLists: jest.fn((qc: unknown) => actual.invalidateLocationLists(qc)),
  };
});

import { useAddLocation, useDeleteSettingsLocation, useLocationOptions } from "@/hooks/use-admin";
import { invalidateLocationLists, locationKeys, useLocations } from "@/hooks/use-locations";

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

describe("FR1-4 — admin location changes refresh EVERY location list", () => {
  it.each([
    ["create", () => useAddLocation(), "Backroom"],
    ["delete", () => useDeleteSettingsLocation(), 4],
  ] as const)("%s: invalidates locationKeys.all and [\"admin\", \"location-options\"] beside the settings", async (_name, hook, arg) => {
    mockFetch.mockResolvedValue(okResponse());
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(hook as () => { mutateAsync: (v: unknown) => Promise<unknown> }, { wrapper: Harness });

    await act(async () => {
      await result.current.mutateAsync(arg);
    });

    expect(locationKeys.all).toEqual(["locations"]);
    // Through the owner's helper, with this client.
    expect(invalidateLocationLists).toHaveBeenCalledTimes(1);
    expect(invalidateLocationLists).toHaveBeenCalledWith(client);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: locationKeys.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "location-options"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "settings"] });
    expect(mockRetryLocations).toHaveBeenCalledTimes(1);
  });

  it("a cached `useLocations` list and the admin location options are refetched after a create", async () => {
    let catalogue = [{ id: 1, name: "Main" }];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/locations") return { ok: true, status: 200, json: async () => catalogue };
      if (url === "/api/admin/locations" && init?.method === "POST") {
        catalogue = [...catalogue, { id: 2, name: "Backroom" }];
        return okResponse();
      }
      return okResponse();
    });
    const lists = renderHook(
      () => ({ shared: useLocations(), admin: useLocationOptions(), add: useAddLocation() }),
      { wrapper: Harness },
    );
    await waitFor(() => expect(lists.result.current.shared.data?.map((l) => l.id)).toEqual([1]));
    await waitFor(() => expect(lists.result.current.admin.data?.map((l) => l.id)).toEqual([1]));

    await act(async () => {
      await lists.result.current.add.mutateAsync("Backroom");
    });
    await waitFor(() => expect(lists.result.current.shared.data?.map((l) => l.id)).toEqual([1, 2]));
    await waitFor(() => expect(lists.result.current.admin.data?.map((l) => l.id)).toEqual([1, 2]));
  });

  it("a refused create or delete invalidates no location list", async () => {
    mockFetch.mockResolvedValue(refusedResponse());
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const add = renderHook(() => useAddLocation(), { wrapper: Harness });
    const del = renderHook(() => useDeleteSettingsLocation(), { wrapper: Harness });
    await act(async () => {
      await add.result.current.mutateAsync("Backroom").catch(() => {});
      await del.result.current.mutateAsync(4).catch(() => {});
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: locationKeys.all });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["admin", "location-options"] });
    expect(invalidateLocationLists).not.toHaveBeenCalled();
  });
});

describe("FR1-4 (S1 ruling) — `invalidateLocationLists`, the key owner's helper", () => {
  const { invalidateLocationLists: realInvalidate } = jest.requireActual("@/hooks/use-locations") as {
    invalidateLocationLists: (qc: QueryClient) => Promise<void>;
  };

  it("invalidates exactly the `locationKeys.all` key", async () => {
    const invalidate = jest.spyOn(client, "invalidateQueries");
    await realInvalidate(client);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: locationKeys.all });
  });

  it("marks a cached `useLocations` list stale and refetches it on screen; other keys are untouched", async () => {
    let catalogue = [{ id: 1, name: "Main" }];
    mockFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => catalogue }));
    client.setQueryData(["admin", "settings"], { untouched: true });
    const shared = renderHook(() => useLocations(), { wrapper: Harness });
    await waitFor(() => expect(shared.result.current.data?.map((l) => l.id)).toEqual([1]));

    catalogue = [...catalogue, { id: 2, name: "Backroom" }];
    await act(async () => {
      await realInvalidate(client);
    });
    await waitFor(() => expect(shared.result.current.data?.map((l) => l.id)).toEqual([1, 2]));
    expect(client.getQueryState(["admin", "settings"])?.isInvalidated).toBe(false);
  });
});
