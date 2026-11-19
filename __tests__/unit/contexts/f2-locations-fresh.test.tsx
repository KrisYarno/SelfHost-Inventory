/** @jest-environment jsdom */
//
// Facelift F2-13 (plan 2026-11-19-facelift-f2, REV 2 A1 as amended by REV 3
// B8) — THE LOCATION LIST STAYS FRESH. Critical-grade surface: the list this
// read loads is what confirms the location every stock write lands on (FR1-1).
//
// Before: the list was read once per signed-in user (FR2-3) and on Retry, so a
// location added or deleted elsewhere showed only after a reload. Now the
// provider records when its last read ATTEMPT started (success or failure);
// when the page becomes `visible` again, signed in, and that attempt is at
// least 5 minutes old, it reads the list again (bumps its reload key). Before
// any attempt, the mount read covers it. One more reader on the shared per-IP
// `/api/locations` bucket, at most once per device per 5 minutes — failing
// reads included (B8).
//
// Unlike `retryLocations`, the visibility path never sets `isLoading` (B8). Its
// answer goes through the same rules as every read: the published id only
// changes on a successful read (FR1-1), and an id deleted elsewhere is
// discarded for NOTHING — the chip asks (FR1-2). Those pins
// (f1-location-rules, fr1-confirmed-location-writers) stay unchanged.

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { LocationProvider, useLocation } from "@/contexts/location-context";

const mockWarning = jest.fn();
jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), { warning: (...a: unknown[]) => mockWarning(...a) }),
}));

type Session = { data: { user: { id: number; defaultLocationId: number | null } } | null };
let mockSession: Session;
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

const signedIn: Session = { data: { user: { id: 1, defaultLocationId: null } } };
const signedOut: Session = { data: null };

const FIVE_MINUTES = 5 * 60 * 1000;
const STALE_WARNING = "Your saved location is no longer available. Choose a location.";

const loc = (id: number) => ({ id, name: `L${id}` });
const ok = (ids: number[]) => ({ ok: true, json: async () => ids.map(loc) });
const refused = () => ({ ok: false, json: async () => ({ error: "boom" }) });

let latest: ReturnType<typeof useLocation> | null;
/** Every `isLoading` a consumer was handed, render by render. */
let loadingSeen: boolean[];
function Probe() {
  latest = useLocation();
  loadingSeen.push(latest.isLoading);
  return null;
}
const tree = () => (
  <LocationProvider>
    <Probe />
  </LocationProvider>
);

/** The clock the provider reads (`Date.now`). */
let now: number;
let visibility: DocumentVisibilityState;
let fetchMock: jest.Mock;
const reads = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/locations").length;

beforeEach(() => {
  latest = null;
  loadingSeen = [];
  mockWarning.mockReset();
  window.localStorage.clear();
  now = 1_700_000_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  visibility = "visible";
  jest.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  fetchMock = jest.fn(async () => ok([1]));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The tab comes back (or goes away): `visibilitychange` on `document`. */
async function becomes(state: DocumentVisibilityState) {
  visibility = state;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {});
}

/** Mounts signed in; the first read (started at `now`) has succeeded and confirmed L1. */
async function mountSignedIn() {
  mockSession = signedIn;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(tree());
  });
  await waitFor(() => expect(latest?.selectedLocationId).toBe(1));
  expect(reads()).toBe(1);
  return view;
}

/** A read that answers only when the test says so. */
function heldRead() {
  let answer!: (v: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise((r) => (answer = r)));
  return (v: unknown) => answer(v);
}

describe("F2-13 — a visible tab re-reads once the last read attempt is 5 minutes old", () => {
  it("visible at exactly 5 minutes after the last attempt: ONE more read", async () => {
    await mountSignedIn();
    now += FIVE_MINUTES;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(2));
    await act(async () => {});
    expect(reads()).toBe(2);
  });

  it("visible under 5 minutes: no read — and the same tab at 5 minutes then reads", async () => {
    await mountSignedIn();
    now += FIVE_MINUTES - 1;
    await becomes("visible");
    expect(reads()).toBe(1);

    now += 1;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("at most once per 5 minutes: the re-read resets the clock", async () => {
    await mountSignedIn();
    now += FIVE_MINUTES;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(2));

    now += 60 * 1000;
    await becomes("hidden");
    await becomes("visible");
    now += FIVE_MINUTES - 60 * 1000 - 1;
    await becomes("visible");
    expect(reads()).toBe(2);

    now += 1;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(3));
  });

  it("B8: the clock starts when the read STARTS — a second return while it is in flight reads nothing", async () => {
    await mountSignedIn();
    const answer = heldRead();
    now += FIVE_MINUTES;
    await becomes("visible");
    expect(reads()).toBe(2);

    now += 30 * 1000;
    await becomes("hidden");
    await becomes("visible");
    expect(reads()).toBe(2);

    await act(async () => {
      answer(ok([1]));
    });
    await waitFor(() => expect(latest?.selectedLocationId).toBe(1));
    expect(reads()).toBe(2);
  });

  it("the page going HIDDEN reads nothing, however old the list", async () => {
    await mountSignedIn();
    now += 10 * FIVE_MINUTES;
    await becomes("hidden");
    expect(reads()).toBe(1);
  });
});

describe("F2-13 (B8) — failing reads re-read at most once per 5 minutes", () => {
  it("every read refused: the mount read, then ONE re-read per 5 minutes of returns, never more", async () => {
    mockSession = signedIn;
    fetchMock.mockImplementation(async () => refused());
    await act(async () => {
      render(tree());
    });
    await waitFor(() => expect(latest?.loadFailed).toBe(true));
    expect(reads()).toBe(1);

    // Under 5 minutes since the failed mount read: nothing.
    now += FIVE_MINUTES - 1;
    await becomes("visible");
    expect(reads()).toBe(1);

    // 5 minutes: one re-read; it fails too.
    now += 1;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(2));
    expect(latest?.loadFailed).toBe(true);

    // Tab switching for the next 5 minutes reads nothing, failures or not.
    for (let i = 0; i < 9; i++) {
      now += 30 * 1000;
      await becomes("hidden");
      await becomes("visible");
    }
    expect(reads()).toBe(2);

    // 5 minutes after the second attempt: one more.
    now += 30 * 1000;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(3));
  });

  it("a failed Retry is an attempt: it restarts the clock", async () => {
    await mountSignedIn();
    now += 4 * 60 * 1000;
    fetchMock.mockImplementationOnce(async () => refused());
    await act(async () => {
      latest!.retryLocations();
    });
    await waitFor(() => expect(latest?.loadFailed).toBe(true));
    expect(reads()).toBe(2);

    // 5 minutes after the MOUNT read, but only 1 minute after the Retry: nothing.
    now += 60 * 1000;
    await becomes("visible");
    expect(reads()).toBe(2);

    // 5 minutes after the Retry: one re-read, and it recovers.
    now += 4 * 60 * 1000;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(3));
    await waitFor(() => expect(latest?.loadFailed).toBe(false));
  });
});

describe("F2-13 (B8) — a visibility re-read never sets isLoading", () => {
  it("success and failure: isLoading stays false on every render; a Retry, by contrast, sets it", async () => {
    await mountSignedIn();
    const settled = loadingSeen.length;

    now += FIVE_MINUTES;
    const answer = heldRead();
    await becomes("visible");
    expect(reads()).toBe(2);
    expect(latest?.isLoading).toBe(false);
    await act(async () => {
      answer(ok([1, 2]));
    });
    await waitFor(() => expect(latest?.locations.map((l) => l.id)).toEqual([1, 2]));

    now += FIVE_MINUTES;
    fetchMock.mockImplementationOnce(async () => refused());
    await becomes("visible");
    await waitFor(() => expect(latest?.loadFailed).toBe(true));
    expect(reads()).toBe(3);

    expect(loadingSeen.slice(settled)).not.toContain(true);

    // The probe does see a loading state when one is set: Retry sets it.
    await act(async () => {
      latest!.retryLocations();
    });
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    expect(loadingSeen.slice(settled)).toContain(true);
  });
});

describe("F2-13 — signed out, nothing", () => {
  it("never signed in: no read on mount and none on visibility", async () => {
    mockSession = signedOut;
    await act(async () => {
      render(tree());
    });
    now += 10 * FIVE_MINUTES;
    await becomes("visible");
    expect(reads()).toBe(0);
  });

  it("signed in, read, then signed out: a visible tab at 5 minutes reads nothing", async () => {
    const view = await mountSignedIn();
    mockSession = signedOut;
    await act(async () => {
      view.rerender(tree());
    });
    now += 10 * FIVE_MINUTES;
    await becomes("visible");
    expect(reads()).toBe(1);
  });
});

describe("F2-13 — the re-read keeps FR1-1 / FR1-2", () => {
  it("while the re-read is in flight, the confirmed id stays published", async () => {
    await mountSignedIn();
    const answer = heldRead();
    now += FIVE_MINUTES;
    await becomes("visible");
    expect(reads()).toBe(2);
    expect(latest?.selectedLocationId).toBe(1);

    await act(async () => {
      answer(ok([1, 2]));
    });
    await waitFor(() => expect(latest?.locations.map((l) => l.id)).toEqual([1, 2]));
    expect(latest?.selectedLocationId).toBe(1);
  });

  it("a location deleted elsewhere: the re-read discards it for NOTHING, warns once, and the chip asks", async () => {
    await mountSignedIn();
    fetchMock.mockImplementation(async () => ok([2]));
    now += FIVE_MINUTES;
    await becomes("visible");
    await waitFor(() => expect(latest?.locations.map((l) => l.id)).toEqual([2]));
    await act(async () => {});
    expect(latest?.selectedLocationId).toBeNull();
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning).toHaveBeenCalledWith(STALE_WARNING);
  });

  it("a failed re-read keeps the confirmed id published (a failed refresh changes nothing)", async () => {
    await mountSignedIn();
    fetchMock.mockImplementation(async () => refused());
    now += FIVE_MINUTES;
    await becomes("visible");
    await waitFor(() => expect(latest?.loadFailed).toBe(true));
    expect(latest?.selectedLocationId).toBe(1);
    expect(latest?.locations.map((l) => l.id)).toEqual([1]);
  });

  it("a restored id still waits for the first read: a return under 5 minutes reads nothing, and the id stays unpublished", async () => {
    window.localStorage.setItem("selectedLocationId", "1");
    mockSession = signedIn;
    const answer = heldRead();
    await act(async () => {
      render(tree());
    });
    expect(latest?.selectedLocationId).toBeNull();

    now += FIVE_MINUTES - 1;
    await becomes("visible");
    expect(reads()).toBe(1);
    expect(latest?.selectedLocationId).toBeNull();

    await act(async () => {
      answer(ok([1]));
    });
    await waitFor(() => expect(latest?.selectedLocationId).toBe(1));
  });

  it("a restored id over a FAILED first read stays unpublished until a visibility re-read succeeds", async () => {
    window.localStorage.setItem("selectedLocationId", "1");
    mockSession = signedIn;
    fetchMock.mockImplementation(async () => refused());
    await act(async () => {
      render(tree());
    });
    await waitFor(() => expect(latest?.loadFailed).toBe(true));
    expect(latest?.selectedLocationId).toBeNull();

    // A failed re-read: still unpublished.
    now += FIVE_MINUTES;
    await becomes("visible");
    await waitFor(() => expect(reads()).toBe(2));
    expect(latest?.selectedLocationId).toBeNull();

    // A successful one confirms it.
    fetchMock.mockImplementation(async () => ok([1]));
    now += FIVE_MINUTES;
    await becomes("visible");
    await waitFor(() => expect(latest?.selectedLocationId).toBe(1));
    expect(reads()).toBe(3);
  });
});
