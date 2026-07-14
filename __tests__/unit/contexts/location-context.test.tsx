/** @jest-environment jsdom */
//
// P2 (Lane 5): LocationContext value referential-stability. The provider now
// memoizes its value, so an unrelated parent re-render must hand the SAME object
// identity to consumers when the memo deps (locations, selectedLocation,
// selectedLocationId, isLoading) are unchanged.

import React from "react";
import { render, act, waitFor } from "@testing-library/react";
import { LocationProvider, useLocation } from "@/contexts/location-context";

// Stable session object (same identity every render) so the provider's
// `[session]`-keyed fetch effect runs exactly once instead of looping.
jest.mock("next-auth/react", () => {
  const session = { data: { user: { defaultLocationId: 1 } } };
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
