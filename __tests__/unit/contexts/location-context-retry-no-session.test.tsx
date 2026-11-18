/** @jest-environment jsdom */
//
// Facelift F0 FR2-4 (plan 2026-11-17-facelift-f0, REV 7; FD1-5) — Retry without
// a session.
//
// FR1-3's `retryLocations` set `isLoading` and bumped the fetch effect's key —
// but that effect reads `/api/locations` only when there IS a session. With
// none (signed out under an open page), a Retry left `isLoading` true with no
// read in flight to ever clear it: the dashboard's location cards sat on their
// skeletons for good. Now a Retry with no session does nothing at all.
//
// Own file: the sibling suite mocks a session that never changes.

import React from "react";
import { render, act, waitFor } from "@testing-library/react";
import { LocationProvider, useLocation } from "@/contexts/location-context";

const SIGNED_IN = { data: { user: { defaultLocationId: 1 } } };
const SIGNED_OUT = { data: null };
let mockSession: { data: unknown } = SIGNED_IN;
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

let latest: ReturnType<typeof useLocation> | null;
function Probe() {
  latest = useLocation();
  return null;
}
const tree = () => (
  <LocationProvider>
    <Probe />
  </LocationProvider>
);

let fetchMock: jest.Mock;
beforeEach(() => {
  latest = null;
  mockSession = SIGNED_IN;
  fetchMock = jest.fn(async () => ({ ok: false, json: async () => ({ error: "boom" }) }));
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("FR2-4 — retryLocations with no session", () => {
  it("does nothing: no read, and isLoading is never set with no fetch to clear it", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(tree());
    });
    // Signed in: the read went out, failed, and the load settled.
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    expect(latest?.loadFailed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The session goes away under the open page.
    mockSession = SIGNED_OUT;
    await act(async () => {
      view.rerender(tree());
    });
    expect(latest?.isLoading).toBe(false);

    await act(async () => {
      latest!.retryLocations();
    });
    await act(async () => {});
    expect(latest?.isLoading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("with a session, Retry still reads again (unchanged)", async () => {
    await act(async () => {
      render(tree());
    });
    await waitFor(() => expect(latest?.isLoading).toBe(false));

    await act(async () => {
      latest!.retryLocations();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(latest?.isLoading).toBe(false));
  });
});
