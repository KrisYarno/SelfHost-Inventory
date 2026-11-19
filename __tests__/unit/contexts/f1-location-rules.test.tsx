/** @jest-environment jsdom */
//
// Facelift F1-5 (plan 2026-11-18-facelift-f1 REV 2; FL-A-3; OC1-8..10, G1-12)
// — THE LOCATION CONTEXT'S RULES. Critical-grade: the selected location is
// where every stock write lands (quick adjust, stock in, transfer, the Journal,
// the workbench's Complete).
//
// Before: the saved id was never checked against the list, so a removed
// location left a live id that wrote nowhere the user could see; the default
// was taken unvalidated; and the first read could overwrite a saved choice.
// Now, on every SUCCESSFUL read and never against a loading or failed one:
//   - a current id in the list is kept;
//   - a stale id is discarded for NOTHING — the chip asks, and a one-time
//     warning says so. Facelift FR1-2 (REV 6, OCR-2) reverses REV 4 (A): a
//     discarded id is never replaced by the user's default (nor by the first
//     location) — no write target is chosen for the operator;
//   - nothing saved (first visit): the default when it is in the list,
//     otherwise the first location;
//   - an empty list: nothing selected, and the saved key removed.
//
// Facelift FR1-1 (REV 6, GR-1 = OCR-1): the context PUBLISHES only a confirmed
// id — one a successful read has in the list. A restored id with the first
// read still loading, or failed, is `null` to every consumer (and so to every
// stock write) until a read confirms it.
//
// Every rule is pinned under BOTH session timings. In the app the session
// arrives AFTER mount (`SessionProvider` has no initial session), so the saved
// id is in state before the first read — the flow where the old code kept a
// stale id live. With the session present at mount, the old first read
// overwrote any saved choice with the default.

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { LocationProvider, useLocation } from "@/contexts/location-context";

const mockWarning = jest.fn();
const mockPlainToast = jest.fn();
jest.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => mockPlainToast(...a), {
    warning: (...a: unknown[]) => mockWarning(...a),
  }),
}));

// A stable session object per test: the provider's fetch effect is keyed on it.
type Session = { data: { user: { defaultLocationId: number | null } } | null };
let mockSession: Session;
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

/** The signed-in session the next mount uses (set per test). */
let session: Session;
const signedIn = (defaultLocationId: number | null): Session => ({ data: { user: { defaultLocationId } } });

/** Which session timing this run of the rules uses (see the header). */
let late = false;

const STALE_WARNING = "Your saved location is no longer available. Choose a location.";
// REV 4 (A)'s stale -> default announcement, REMOVED by FR1-2: never shown.
const NOW_WORKING_AT = /now working at/;
const KEY = "selectedLocationId";

const loc = (id: number) => ({ id, name: `L${id}` });
const ok = (ids: number[]) => ({ ok: true, json: async () => ids.map(loc) });
const refused = () => ({ ok: false, json: async () => ({ error: "boom" }) });

let latest: ReturnType<typeof useLocation> | null;
/** Every `selectedLocationId` a consumer was handed, render by render (FR1-1). */
let published: Array<number | null>;
function Probe() {
  latest = useLocation();
  published.push(latest.selectedLocationId);
  return null;
}

let fetchMock: jest.Mock;
beforeEach(() => {
  latest = null;
  published = [];
  mockWarning.mockReset();
  mockPlainToast.mockReset();
  window.localStorage.clear();
  session = signedIn(null);
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

function tree(strict: boolean) {
  const provider = (
    <LocationProvider>
      <Probe />
    </LocationProvider>
  );
  return strict ? <React.StrictMode>{provider}</React.StrictMode> : provider;
}

/**
 * Mounts the provider with this run's session timing; the first read is in
 * flight (or answered) when it returns.
 */
async function start({ strict = false } = {}) {
  mockSession = late ? { data: null } : session;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(tree(strict));
  });
  if (late) {
    await act(async () => {});
    mockSession = session;
    await act(async () => {
      view.rerender(tree(strict));
    });
  }
}

/** Mounts the provider and waits for the first read to settle. */
async function mount({ strict = false } = {}) {
  await start({ strict });
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  // let the rules' updates commit
  await act(async () => {});
}

/** Reads `/api/locations` again and waits for it to settle. */
async function refresh() {
  await act(async () => {
    latest!.retryLocations();
  });
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  await act(async () => {});
}

describe.each([
  ["the session arrives after mount (the app's flow)", true],
  ["the session is present at mount", false],
])("%s", (_timing, lateSession) => {
  beforeEach(() => {
    late = lateSession;
  });

  describe("FR1-1 — consumers only ever see a CONFIRMED location", () => {
    it("a saved id with the first read HELD is null to every consumer; once the read answers with it in the list, it is published", async () => {
      window.localStorage.setItem(KEY, "2");
      let answer!: (value: unknown) => void;
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      await start();
      await act(async () => {});
      expect(latest?.isLoading).toBe(true);
      expect(latest?.selectedLocationId).toBeNull();
      expect(latest?.selectedLocation).toBeNull();

      await act(async () => {
        answer(ok([1, 2]));
      });
      await waitFor(() => expect(latest?.isLoading).toBe(false));
      await act(async () => {});
      expect(latest?.selectedLocationId).toBe(2);
      expect(latest?.selectedLocation).toEqual(loc(2));
      // Nothing but null came before the confirming read.
      expect(published.slice(0, published.indexOf(2)).every((id) => id === null)).toBe(true);
    });

    it("a saved id with the first read REFUSED (e.g. a 429) is null; a successful Retry with it in the list publishes it", async () => {
      window.localStorage.setItem(KEY, "2");
      fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(ok([1, 2]));
      await mount();
      expect(latest?.loadFailed).toBe(true);
      expect(latest?.selectedLocationId).toBeNull();
      expect(published).not.toContain(2);

      await refresh();
      expect(latest?.loadFailed).toBe(false);
      expect(latest?.selectedLocationId).toBe(2);
    });

    it("a saved id the list does not hold is NEVER published — not even for the render before the rules discard it", async () => {
      window.localStorage.setItem(KEY, "9");
      session = signedIn(3);
      fetchMock.mockResolvedValue(ok([1, 3]));
      await mount();
      expect(latest?.selectedLocationId).toBeNull();
      expect(published).not.toContain(9);
      expect(published).not.toContain(3);
    });

    it("the context never calls the plain `toast` (only the stale warning, `toast.warning`)", async () => {
      window.localStorage.setItem(KEY, "9");
      fetchMock.mockResolvedValueOnce(ok([1, 3])).mockResolvedValueOnce(ok([]));
      await mount();
      await act(async () => {
        latest!.setSelectedLocationId(1);
      });
      await refresh();
      expect(mockWarning).toHaveBeenCalledTimes(1);
      expect(mockPlainToast).not.toHaveBeenCalled();
    });
  });

  describe("F1-5 — a current id in the list", () => {
    it("is kept (not replaced by the default or the first), with no warning", async () => {
      window.localStorage.setItem(KEY, "2");
      session = signedIn(1);
      fetchMock.mockResolvedValue(ok([1, 2, 3]));
      await mount();
      expect(latest?.selectedLocationId).toBe(2);
      expect(latest?.selectedLocation).toEqual(loc(2));
      expect(window.localStorage.getItem(KEY)).toBe("2");
      expect(mockWarning).not.toHaveBeenCalled();
    });
  });

  describe("F1-5 / FR1-2 — a stale saved id (not in the list) is discarded, and the chip asks", () => {
    it.each([
      ["no default", null],
      ["a default that IS in the list", 3],
      ["a default that is not in the list either", 7],
    ])("with %s: NOTHING selected — never the default, never the first location — and the warning ONCE", async (_what, def) => {
      window.localStorage.setItem(KEY, "9");
      session = signedIn(def);
      fetchMock.mockResolvedValue(ok([1, 3]));
      // StrictMode runs every effect twice: the warning must still show once.
      await mount({ strict: true });

      expect(latest?.selectedLocationId).toBeNull();
      expect(latest?.selectedLocation).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(1);
      expect(mockWarning).toHaveBeenCalledWith(STALE_WARNING);
      expect(mockWarning).not.toHaveBeenCalledWith(expect.stringMatching(NOW_WORKING_AT));
      // The stale key is kept, so a reload asks again (REV 4 reading); no other id is saved.
      expect(window.localStorage.getItem(KEY)).toBe("9");

      // A later successful read does not fill the choice in, and says nothing again.
      const reads = fetchMock.mock.calls.length;
      await refresh();
      expect(fetchMock).toHaveBeenCalledTimes(reads + 1);
      expect(latest?.selectedLocationId).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(1);
    });

    it("while the chip asks, any other unknown id is discarded too — with no second warning", async () => {
      window.localStorage.setItem(KEY, "9");
      fetchMock.mockResolvedValue(ok([1, 3]));
      await mount();
      expect(latest?.selectedLocationId).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(1);

      await act(async () => {
        latest!.setSelectedLocationId(42);
      });
      await act(async () => {});
      expect(latest?.selectedLocationId).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(1);
    });

    it("ONCE per discard: a location removed later, while in use, warns again — and is never replaced by the default", async () => {
      window.localStorage.setItem(KEY, "3");
      session = signedIn(1);
      fetchMock
        .mockResolvedValueOnce(ok([1, 3]))
        .mockResolvedValueOnce(ok([1]))
        .mockResolvedValueOnce(ok([1, 2]))
        .mockResolvedValueOnce(ok([2]));
      await mount();
      expect(latest?.selectedLocationId).toBe(3);
      expect(mockWarning).not.toHaveBeenCalled();

      // Location 3 (in use) is removed: a discard, for nothing — the default (1)
      // is in the list and is NOT chosen.
      await refresh();
      expect(latest?.selectedLocationId).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(1);
      expect(mockWarning).toHaveBeenLastCalledWith(STALE_WARNING);

      // The user chooses 1; it is kept through a read.
      await act(async () => {
        latest!.setSelectedLocationId(1);
      });
      await refresh();
      expect(latest?.selectedLocationId).toBe(1);
      expect(mockWarning).toHaveBeenCalledTimes(1);

      // Then 1 is removed: a NEW discard, a second warning.
      await refresh();
      expect(latest?.selectedLocationId).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(2);
      expect(mockWarning).toHaveBeenLastCalledWith(STALE_WARNING);
    });

    it("then the user's own choice is kept, through a later read", async () => {
      window.localStorage.setItem(KEY, "9");
      fetchMock.mockResolvedValue(ok([1, 3]));
      await mount();
      expect(latest?.selectedLocationId).toBeNull();

      await act(async () => {
        latest!.setSelectedLocationId(3);
      });
      expect(latest?.selectedLocationId).toBe(3);
      expect(window.localStorage.getItem(KEY)).toBe("3");

      await refresh();
      expect(latest?.selectedLocationId).toBe(3);
      expect(mockWarning).toHaveBeenCalledTimes(1);
    });
  });

  describe("F1-5 — nothing saved (first visit)", () => {
    it("selects the user's default when it is in the list", async () => {
      session = signedIn(3);
      fetchMock.mockResolvedValue(ok([1, 3]));
      await mount();
      expect(latest?.selectedLocationId).toBe(3);
      expect(window.localStorage.getItem(KEY)).toBe("3");
      expect(mockWarning).not.toHaveBeenCalled();
    });

    it.each([
      ["no default", null],
      ["a default that is not in the list", 99],
    ])("with %s, selects the first location", async (_what, def) => {
      session = signedIn(def);
      fetchMock.mockResolvedValue(ok([5, 1]));
      await mount();
      expect(latest?.selectedLocationId).toBe(5);
      expect(window.localStorage.getItem(KEY)).toBe("5");
      expect(mockWarning).not.toHaveBeenCalled();
    });
  });

  describe("F1-5 — an empty successful list", () => {
    it("selects nothing and removes the saved key", async () => {
      window.localStorage.setItem(KEY, "2");
      session = signedIn(2);
      fetchMock.mockResolvedValue(ok([]));
      await mount();
      expect(latest?.selectedLocationId).toBeNull();
      expect(window.localStorage.getItem(KEY)).toBeNull();
      expect(mockWarning).not.toHaveBeenCalled();
    });
  });

  describe("F1-5 — never against a loading or failed read", () => {
    it("a failed refresh over a loaded list changes nothing", async () => {
      window.localStorage.setItem(KEY, "2");
      fetchMock.mockResolvedValueOnce(ok([1, 2])).mockResolvedValueOnce(refused());
      await mount();
      expect(latest?.selectedLocationId).toBe(2);

      await refresh();
      expect(latest?.loadFailed).toBe(true);
      expect(latest?.locations).toEqual([loc(1), loc(2)]);
      expect(latest?.selectedLocationId).toBe(2);
      expect(window.localStorage.getItem(KEY)).toBe("2");
      expect(mockWarning).not.toHaveBeenCalled();
    });

    it("a failed first read leaves the saved id alone: not discarded, not removed, no warning — and NOT published (FR1-1)", async () => {
      window.localStorage.setItem(KEY, "9");
      fetchMock.mockResolvedValue(refused());
      await mount();
      expect(latest?.loadFailed).toBe(true);
      expect(latest?.selectedLocationId).toBeNull();
      expect(latest?.selectedLocation).toBeNull();
      expect(window.localStorage.getItem(KEY)).toBe("9");
      expect(mockWarning).not.toHaveBeenCalled();
    });

    it("while the first read is loading, the saved id is untouched and NOT published (FR1-1); the rules run once it answers", async () => {
      window.localStorage.setItem(KEY, "9");
      let answer!: (value: unknown) => void;
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      await start();
      await act(async () => {});
      expect(latest?.isLoading).toBe(true);
      // The list is still [] while loading — it is not an empty ANSWER.
      expect(latest?.selectedLocationId).toBeNull();
      expect(window.localStorage.getItem(KEY)).toBe("9");
      expect(mockWarning).not.toHaveBeenCalled();

      await act(async () => {
        answer(ok([1, 3]));
      });
      await waitFor(() => expect(latest?.isLoading).toBe(false));
      await act(async () => {});
      expect(latest?.selectedLocationId).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(1);
    });
  });
});
