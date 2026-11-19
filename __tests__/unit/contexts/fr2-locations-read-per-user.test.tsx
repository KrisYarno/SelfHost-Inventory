/** @jest-environment jsdom */
//
// Facelift FR2-3 (plan 2026-11-18-facelift-f1, REV 8; FD1-3; orchestrator
// decision) — THE LOCATIONS READ RUNS PER SIGNED-IN USER, NOT PER SESSION
// OBJECT. Critical-grade surface: the list this read loads is what confirms
// the location every stock write lands on (FR1-1).
//
// Before: the provider's fetch effect depended on the `session` OBJECT. The
// default `SessionProvider` refetches the session on every tab focus and hands
// out a NEW object each time, so every focus re-read `/api/locations` — on the
// shared 30/min per-IP bucket, where a refusal leaves every writer refusing.
// Now the effect keys on the signed-in user's id: a new session object for the
// same user reads nothing; a different user reads once; Retry (the chip's and
// the dashboard's) still reads once.

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { LocationProvider, useLocation } from "@/contexts/location-context";

jest.mock("sonner", () => ({ toast: Object.assign(jest.fn(), { warning: jest.fn() }) }));

type Session = { data: { user: { id: number; defaultLocationId: number | null } } | null };
let mockSession: Session;
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

/** A NEW session object every call — what a focus refetch hands out. */
const sessionFor = (id: number): Session => ({ data: { user: { id, defaultLocationId: null } } });

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
const locationReads = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/locations").length;

beforeEach(() => {
  latest = null;
  window.localStorage.clear();
  fetchMock = jest.fn(async () => ({ ok: true, json: async () => [{ id: 1, name: "Main" }] }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Mounts signed in as user 1; the first read has settled. */
async function mountSignedIn() {
  mockSession = sessionFor(1);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(tree());
  });
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  await act(async () => {});
  expect(locationReads()).toBe(1);
  return view;
}

/** Hands the provider a NEW session object, and lets any effect run. */
async function newSession(view: ReturnType<typeof render>, session: Session) {
  mockSession = session;
  await act(async () => {
    view.rerender(tree());
  });
  await act(async () => {});
}

describe("FR2-3 — the locations read is keyed on the signed-in user", () => {
  it("a NEW session object for the SAME user (a tab focus) issues NO new read", async () => {
    const view = await mountSignedIn();
    for (let focus = 0; focus < 3; focus++) {
      await newSession(view, sessionFor(1));
    }
    expect(locationReads()).toBe(1);
    expect(latest?.isLoading).toBe(false);
    expect(latest?.selectedLocationId).toBe(1);
  });

  it("a DIFFERENT user id issues ONE read", async () => {
    const view = await mountSignedIn();
    await newSession(view, sessionFor(2));
    await waitFor(() => expect(locationReads()).toBe(2));
    await act(async () => {});
    expect(locationReads()).toBe(2);
  });

  it("Retry issues ONE read", async () => {
    await mountSignedIn();
    await act(async () => {
      latest!.retryLocations();
    });
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    await act(async () => {});
    expect(locationReads()).toBe(2);
  });
});
