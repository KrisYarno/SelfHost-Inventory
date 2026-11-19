/** @jest-environment jsdom */
//
// P2 (Lane 5): LocationContext value referential-stability. The provider now
// memoizes its value, so an unrelated parent re-render must hand the SAME object
// identity to consumers when the memo deps (locations, selectedLocation,
// selectedLocationId, isLoading) are unchanged.

import React from "react";
import { render, act, waitFor } from "@testing-library/react";
import { LocationProvider, useLocation } from "@/contexts/location-context";

// Stable session object (same identity every render). The provider's fetch
// effect is keyed on the signed-in user's id (facelift FR2-3), so the session
// carries one — the real session always does (lib/auth.ts).
jest.mock("next-auth/react", () => {
  const session = { data: { user: { id: 1, defaultLocationId: 1 } } };
  return { useSession: () => session };
});

describe("LocationContext value memoization (P2)", () => {
  const captured: unknown[] = [];
  let bump: () => void;

  beforeEach(() => {
    captured.length = 0;
    // /api/locations resolves to an empty list -> no post-mount state churn.
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [],
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Probe re-renders on every parent render (via the `tick` prop) and records the
  // current context value each time, so we can compare identities across a parent
  // re-render that does NOT change any provider state.
  function Probe({ tick }: { tick: number }) {
    const value = useLocation();
    captured.push(value);
    return <span data-testid="tick">{tick}</span>;
  }

  function Harness() {
    const [tick, setTick] = React.useState(0);
    bump = () => setTick((t) => t + 1);
    return (
      <LocationProvider>
        <Probe tick={tick} />
      </LocationProvider>
    );
  }

  test("value keeps the same object identity across an unrelated parent re-render", async () => {
    await act(async () => {
      render(<Harness />);
    });
    // Let the mount-time fetch effect settle (setLoading(false) etc.).
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));

    const before = captured[captured.length - 1];

    // Force an unrelated parent re-render; no provider state changes.
    await act(async () => {
      bump();
    });

    const after = captured[captured.length - 1];
    // A new capture must have happened (Probe re-rendered on the new tick prop)...
    expect(captured.length).toBeGreaterThan(1);
    // ...and the context value object identity must be preserved.
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-3: a failed `/api/locations` read is not "no locations". The
// context says it failed (`loadFailed`, cleared by a successful read) and can
// read again (`retryLocations`).
// ---------------------------------------------------------------------------

describe("LocationContext — loadFailed and retryLocations (FR1-3)", () => {
  let latest: ReturnType<typeof useLocation> | null;

  function Probe() {
    latest = useLocation();
    return null;
  }

  beforeEach(() => {
    latest = null;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function mount() {
    await act(async () => {
      render(
        <LocationProvider>
          <Probe />
        </LocationProvider>
      );
    });
    await waitFor(() => expect(latest?.isLoading).toBe(false));
  }

  test.each([
    ["answers non-ok", async () => ({ ok: false, json: async () => ({ error: "boom" }) })],
    [
      "throws",
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("a read that %s sets loadFailed, with no locations", async (_label, answer) => {
    global.fetch = jest.fn(answer) as unknown as typeof fetch;
    await mount();
    expect(latest?.loadFailed).toBe(true);
    expect(latest?.locations).toEqual([]);
  });

  test("a successful read leaves loadFailed false", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
    await mount();
    expect(latest?.loadFailed).toBe(false);
  });

  test("retryLocations reads again; a successful retry clears loadFailed and loads the list", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "boom" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 1, name: "Main" }] });
    global.fetch = fetchMock as unknown as typeof fetch;
    await mount();
    expect(latest?.loadFailed).toBe(true);

    await act(async () => {
      latest!.retryLocations();
    });
    await waitFor(() => expect(latest?.loadFailed).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.locations).toEqual([{ id: 1, name: "Main" }]);
    expect(latest?.isLoading).toBe(false);
  });

  test("a retry that fails again keeps loadFailed", async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, json: async () => ({ error: "boom" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await mount();

    await act(async () => {
      latest!.retryLocations();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    expect(latest?.loadFailed).toBe(true);
  });
});
