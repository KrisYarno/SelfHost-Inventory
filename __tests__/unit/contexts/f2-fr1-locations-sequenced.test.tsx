/** @jest-environment jsdom */
//
// Facelift F2 fix round FR1 (plan 2026-11-19-facelift-f2, REV 7) — THE
// LOCATIONS READ, SEQUENCED AND BOUNDED. Critical-grade: the list this read
// loads is what confirms the location every stock write lands on (F1 FR1-1).
//
// FR1-5: a Retry, an admin's location change or a returning tab can start a
// read while an older one is in flight, and the two can land in either order.
// Every read takes a monotonic id; its answer (`setLocations`, `setLoadFailed`,
// the first-visit pick) and its `finally` (`setIsLoading(false)`) apply ONLY
// while its id is still the latest. A superseded answer changes nothing: a
// deleted location never comes back, and `isLoading` is not cleared early.
//
// FR1-11: the read carries `AbortSignal.timeout(10_000)`. A read that has not
// answered in 10 s fails (`loadFailed`, `isLoading` false) and publishes no id
// (F1 FR1-1), so nothing waiting on the list (the Products list, A14) waits
// forever. GUARDED like the move's clock: a browser without
// `AbortSignal.timeout` reads with no signal, as before, instead of failing
// every read before it starts.
//
// F1 FR1-1 / FR1-2 and F2-13 are unchanged (their own suites stay green).

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

const loc = (id: number) => ({ id, name: `L${id}` });
const ok = (ids: number[]) => ({ ok: true, json: async () => ids.map(loc) });
const refused = () => ({ ok: false, json: async () => ({ error: "boom" }) });

let latest: ReturnType<typeof useLocation> | null;
/** What consumers were handed, render by render. */
let seen: Array<{ isLoading: boolean; ids: number[]; selected: number | null; loadFailed: boolean }>;
function Probe() {
  latest = useLocation();
  seen.push({
    isLoading: latest.isLoading,
    ids: latest.locations.map((l) => l.id),
    selected: latest.selectedLocationId,
    loadFailed: latest.loadFailed,
  });
  return null;
}
const tree = () => (
  <LocationProvider>
    <Probe />
  </LocationProvider>
);

let fetchMock: jest.Mock;
const reads = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/locations").length;

/** Every read waits for the test; `answer(i, res)` settles read number i. */
let pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal }>;
function holdEveryRead() {
  fetchMock.mockImplementation(
    (_url: unknown, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal: init?.signal ?? undefined };
        pending.push(entry);
        // A real fetch rejects when its signal aborts (FR1-11's timeout).
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  );
}
async function answer(i: number, res: unknown) {
  await act(async () => {
    pending[i].resolve(res);
  });
  await act(async () => {});
}
async function fail(i: number) {
  await act(async () => {
    pending[i].reject(new TypeError("Failed to fetch"));
  });
  await act(async () => {});
}

beforeEach(() => {
  latest = null;
  seen = [];
  pending = [];
  mockWarning.mockReset();
  window.localStorage.clear();
  mockSession = { data: { user: { id: 1, defaultLocationId: null } } };
  fetchMock = jest.fn(async () => ok([1]));
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function mount() {
  await act(async () => {
    render(tree());
  });
}

describe("FR1-5 — an older read landing after a newer one changes nothing", () => {
  it("a deleted location never comes back: the mount read (old list) lands AFTER the Retry's (location 2 deleted)", async () => {
    holdEveryRead();
    await mount();
    expect(reads()).toBe(1);
    await act(async () => {
      latest!.retryLocations();
    });
    expect(reads()).toBe(2);

    await answer(1, ok([1])); // the newer read: location 2 is gone
    await waitFor(() => expect(latest?.locations.map((l) => l.id)).toEqual([1]));
    expect(latest?.selectedLocationId).toBe(1);
    expect(latest?.isLoading).toBe(false);

    const from = seen.length;
    await answer(0, ok([1, 2])); // the older read, still holding location 2
    expect(latest?.locations.map((l) => l.id)).toEqual([1]);
    expect(seen.slice(from).some((s) => s.ids.includes(2))).toBe(false);
    expect(latest?.selectedLocationId).toBe(1);
    expect(latest?.loadFailed).toBe(false);
  });

  it("isLoading is not cleared early: the OLDER read landing first leaves the newer one loading, and applies nothing", async () => {
    holdEveryRead();
    await mount();
    await act(async () => {
      latest!.retryLocations();
    });
    expect(latest?.isLoading).toBe(true);

    await answer(0, ok([1, 2]));
    expect(latest?.isLoading).toBe(true);
    expect(latest?.locations).toEqual([]);
    expect(latest?.selectedLocationId).toBeNull();

    await answer(1, ok([1]));
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    expect(latest?.locations.map((l) => l.id)).toEqual([1]);
    expect(latest?.selectedLocationId).toBe(1);
  });

  it("a superseded FAILED read changes nothing: no loadFailed over the newer answer", async () => {
    holdEveryRead();
    await mount();
    await act(async () => {
      latest!.retryLocations();
    });
    await answer(1, ok([1]));
    await waitFor(() => expect(latest?.selectedLocationId).toBe(1));

    await fail(0);
    expect(latest?.loadFailed).toBe(false);
    await answer(0, refused()); // (already settled: a no-op)
    expect(latest?.loadFailed).toBe(false);
    expect(seen.some((s) => s.loadFailed)).toBe(false);
  });

  it("a superseded REFUSED read changes nothing either", async () => {
    holdEveryRead();
    await mount();
    await act(async () => {
      latest!.retryLocations();
    });
    await answer(1, ok([1]));
    await waitFor(() => expect(latest?.selectedLocationId).toBe(1));
    await answer(0, refused());
    expect(latest?.loadFailed).toBe(false);
    expect(latest?.locations.map((l) => l.id)).toEqual([1]);
  });

  it("a superseded read never makes the first-visit pick: the newer read's (empty) answer stands", async () => {
    holdEveryRead();
    await mount();
    await act(async () => {
      latest!.retryLocations();
    });
    await answer(1, ok([]));
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    expect(latest?.selectedLocationId).toBeNull();

    await answer(0, ok([1, 2]));
    expect(latest?.locations).toEqual([]);
    expect(latest?.selectedLocationId).toBeNull();
  });

  it("superseded WHILE its body is being read: the older answer's list still never lands", async () => {
    holdEveryRead();
    await mount();
    // The mount read's headers arrive, but its body is still being read...
    let finishBody!: (ids: number[]) => void;
    const slowBody = new Promise<Array<{ id: number; name: string }>>((r) => {
      finishBody = (ids) => r(ids.map(loc));
    });
    await answer(0, { ok: true, json: () => slowBody });
    // ...when a Retry starts a newer read, which answers first.
    await act(async () => {
      latest!.retryLocations();
    });
    await answer(1, ok([1]));
    await waitFor(() => expect(latest?.selectedLocationId).toBe(1));

    await act(async () => {
      finishBody([1, 2]);
    });
    await act(async () => {});
    expect(latest?.locations.map((l) => l.id)).toEqual([1]);
    expect(seen.some((s) => s.ids.includes(2))).toBe(false);
  });

  it("the latest read still applies normally: three reads, answered newest-first then oldest, only the newest counts", async () => {
    holdEveryRead();
    await mount();
    await act(async () => {
      latest!.retryLocations();
    });
    await act(async () => {
      latest!.retryLocations();
    });
    expect(reads()).toBe(3);
    await answer(2, ok([3]));
    await waitFor(() => expect(latest?.selectedLocationId).toBe(3));
    await answer(1, ok([1, 3]));
    await answer(0, ok([1, 2, 3]));
    expect(latest?.locations.map((l) => l.id)).toEqual([3]);
    expect(latest?.selectedLocationId).toBe(3);
  });
});

describe("FR1-11 — a held read cannot stall the page forever", () => {
  it("a read held past 10 s fails: loadFailed, isLoading false, and NO published id (a restored id stays unpublished)", async () => {
    jest.useFakeTimers();
    window.localStorage.setItem("selectedLocationId", "1");
    holdEveryRead();
    await mount();
    expect(reads()).toBe(1);
    expect(latest?.isLoading).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(9_999);
    });
    expect(latest?.isLoading).toBe(true);
    expect(latest?.loadFailed).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await act(async () => {});
    expect(latest?.loadFailed).toBe(true);
    expect(latest?.isLoading).toBe(false);
    expect(latest?.selectedLocationId).toBeNull();
    expect(latest?.selectedLocation).toBeNull();
    expect(seen.some((s) => s.selected !== null)).toBe(false);
    // The saved id is left alone (unpublished), for a read that succeeds.
    expect(window.localStorage.getItem("selectedLocationId")).toBe("1");
  });

  it("each read carries a 10 s AbortSignal; a read that answers in time is unaffected by it", async () => {
    jest.useFakeTimers();
    holdEveryRead();
    await mount();
    const signal = pending[0].signal!;
    expect(signal).toBeInstanceOf(AbortSignal);
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await answer(0, ok([1]));
    expect(latest?.selectedLocationId).toBe(1);
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(latest?.loadFailed).toBe(false);
    expect(latest?.selectedLocationId).toBe(1);
  });

  it("after a timed-out read, a Retry that answers confirms the id", async () => {
    jest.useFakeTimers();
    window.localStorage.setItem("selectedLocationId", "1");
    holdEveryRead();
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await act(async () => {});
    expect(latest?.loadFailed).toBe(true);

    await act(async () => {
      latest!.retryLocations();
    });
    await answer(1, ok([1, 2]));
    expect(latest?.loadFailed).toBe(false);
    expect(latest?.selectedLocationId).toBe(1);
  });

  it("GUARDED: with no AbortSignal.timeout (older WebViews) the read still runs, with no signal, and confirms the id", async () => {
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
    try {
      await mount();
      await waitFor(() => expect(latest?.selectedLocationId).toBe(1));
      expect(latest?.loadFailed).toBe(false);
      const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit | undefined];
      expect(init?.signal).toBeUndefined();
    } finally {
      Object.defineProperty(AbortSignal, "timeout", { value: original, configurable: true, writable: true });
    }
  });
});
