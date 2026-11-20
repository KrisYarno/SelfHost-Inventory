/** @jest-environment jsdom */
//
// Facelift FR3-2 (plan 2026-11-18-facelift-f1, REV 11; QA-1) — THE FIRST-VISIT
// PICK LANDS WITH THE READ. Critical-grade: the selected location is where
// every stock write lands.
//
// Before: the read set the list and cleared `isLoading` in one batch, and the
// rules effect made the first-visit pick (nothing saved: the user's default
// when it is in the list, otherwise the first location) one commit LATER. For
// that one render every consumer saw a loaded list — not loading, not failed —
// with NOTHING selected. A consumer that decides once, when the list resolves,
// decided on that render: the Fulfill dialog's one-shot seed (MS-1-4) seeded
// nothing, so a first-visit operator's Fulfill said `Select a location` while
// the chip said where they were.
//
// Now the read's success path sets the list and the first-visit pick in the
// SAME batch. A restored saved id is never replaced (it is kept, then
// confirmed or discarded by the rules as before); an id discarded while the
// chip asks is never filled in by a later read; the rules effect stays as the
// backstop. Every pin runs under both session timings (see
// `f1-location-rules.test.tsx`).

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockWarning = jest.fn();
const mockPlainToast = jest.fn();
jest.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => mockPlainToast(...a), {
    warning: (...a: unknown[]) => mockWarning(...a),
    error: jest.fn(),
    success: jest.fn(),
    message: jest.fn(),
    info: jest.fn(),
  }),
}));

type Session = { data: { user: { id: number; isAdmin: boolean; defaultLocationId: number | null } } | null };
let mockSession: Session;
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

jest.mock("@/hooks/use-orders", () => ({
  useFulfillmentValidation: jest.fn(),
  useFulfillOrder: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/components/products/product-map-dialog", () => ({ ProductMapDialog: () => null }));

import { useFulfillmentValidation } from "@/hooks/use-orders";
import { LocationProvider, useLocation } from "@/contexts/location-context";
import { FulfillOrderDialog } from "@/components/orders/fulfill-order-dialog";
import type { ExternalOrder } from "@/types/external-orders";

const KEY = "selectedLocationId";
const STALE_WARNING = "Your saved location is no longer available. Choose a location.";
const LOCATION_NAMES: Record<number, string> = { 1: "Annex", 2: "Main", 3: "Office", 5: "Depot" };
const loc = (id: number) => ({ id, name: LOCATION_NAMES[id] });
const ok = (ids: number[]) => ({ ok: true, status: 200, json: async () => ids.map(loc) }) as unknown as Response;
const refused = () => ({ ok: false, status: 429, json: async () => ({ error: "Too many requests" }) }) as unknown as Response;

const signedIn = (defaultLocationId: number | null): Session => ({
  data: { user: { id: 1, isAdmin: false, defaultLocationId } },
});

/** The session the next mount signs in with (set per test). */
let session: Session;
/** Which session timing this run uses: the app's (after mount), or at mount. */
let late = false;

/**
 * The PROVIDER's `/api/locations` reads, each answered by the test. Facelift
 * F2 FR1-11: the provider's read now carries a signal too — its 10 s
 * `AbortSignal.timeout` — so its reads are told from the dialog's (which pass
 * react-query's signal) by THAT signal, recorded as it is made.
 */
let providerReads: Array<(res: Response) => void>;
let providerSignals: WeakSet<AbortSignal>;
/** What the Fulfill dialog's own `/api/locations` read answers (it passes a signal). */
let dialogList: number[];
let fetchMock: jest.Mock;

/** What a consumer was handed, render by render. */
type Snap = { isLoading: boolean; loadFailed: boolean; count: number; selected: number | null };
let snaps: Snap[];
let latest: ReturnType<typeof useLocation> | null;
function Recorder() {
  latest = useLocation();
  snaps.push({
    isLoading: latest.isLoading,
    loadFailed: latest.loadFailed,
    count: latest.locations.length,
    selected: latest.selectedLocationId,
  });
  return null;
}
/** Renders where a loaded list (not loading, not failed) had nothing selected. */
const gapRenders = () => snaps.filter((s) => !s.isLoading && !s.loadFailed && s.count > 0 && s.selected === null);
const published = () => snaps.map((s) => s.selected);

beforeEach(() => {
  jest.clearAllMocks();
  latest = null;
  snaps = [];
  providerReads = [];
  dialogList = [1, 2, 3];
  window.localStorage.clear();
  session = signedIn(null);
  jest.spyOn(console, "error").mockImplementation(() => {});
  providerSignals = new WeakSet();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  jest.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const signal = timeout(ms);
    providerSignals.add(signal);
    return signal;
  });
  fetchMock = jest.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/locations") {
      if (!init?.signal || providerSignals.has(init.signal)) {
        return new Promise<Response>((resolve) => providerReads.push(resolve));
      }
      return Promise.resolve(ok(dialogList));
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // No read left pending against a discarded tree.
  providerReads.forEach((resolve) => resolve(ok([])));
  jest.restoreAllMocks();
});

function tree(qc: QueryClient, extra?: React.ReactNode) {
  return (
    <LocationProvider>
      <QueryClientProvider client={qc}>
        <Recorder />
        {extra}
      </QueryClientProvider>
    </LocationProvider>
  );
}

/** Mounts the provider with this run's session timing; the first read is out. */
async function start(extra?: React.ReactNode) {
  mockSession = late ? { data: null } : session;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(tree(qc, extra));
  });
  if (late) {
    await act(async () => {});
    mockSession = session;
    await act(async () => {
      view.rerender(tree(qc, extra));
    });
  }
  await waitFor(() => expect(providerReads.length).toBeGreaterThan(0));
  return view;
}

/** Answers the provider's read number `i` and lets every update commit. */
async function answer(i: number, res: Response) {
  await waitFor(() => expect(providerReads.length).toBeGreaterThan(i));
  await act(async () => {
    providerReads[i](res);
  });
  await act(async () => {});
}

/** Reads `/api/locations` again (the chip's or the dashboard's Retry). */
async function retry() {
  await act(async () => {
    latest!.retryLocations();
  });
}

// The Fulfill dialog (MS-1-4): one open line, mapped; the validation answers
// for whichever location the dialog chose.
const ORDER = {
  id: "ord-1",
  companyId: "co-1",
  integrationId: "int-1",
  externalId: "9001",
  orderNumber: "9001",
  nativeStatus: "processing",
  internalStatus: "processing",
  total: 1,
  currency: "USD",
  customerName: "Ada",
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [
    {
      id: "it-0",
      orderId: "ord-1",
      externalItemId: null,
      externalProductId: "wc-p-000",
      externalVariantId: null,
      name: "Line",
      variantName: null,
      sku: null,
      quantity: 2,
      fulfilledQty: 0,
      price: 1,
      productLinkId: null,
      isMapped: true,
    },
  ],
} as unknown as ExternalOrder;

function validationAnswersFor() {
  (useFulfillmentValidation as jest.Mock).mockImplementation((_orderId: unknown, locationId: number | null) => ({
    data:
      locationId === null
        ? undefined
        : {
            orderId: "ord-1",
            canFulfill: true,
            requiresAttention: false,
            items: [
              {
                itemId: "it-0",
                name: "Line",
                variantName: null,
                sku: null,
                requestedQty: 2,
                remainingQty: 2,
                fulfilledQty: 0,
                isMapped: true,
                mapping: {
                  productId: 501,
                  productName: "Widget",
                  availableByLocation: [{ locationId, locationName: LOCATION_NAMES[locationId], available: 99 }],
                },
                issues: [],
              },
            ],
          },
    isFetching: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }));
}
const fulfilAction = () =>
  screen.getByRole("button", {
    name: /^(Fulfill \d+ lines? from .+|Select a location|No Items to Fulfill|Checking stock at .+)$/,
  });

describe.each([
  ["the session arrives after mount (the app's flow)", true],
  ["the session is present at mount", false],
])("FR3-2 — %s", (_timing, lateSession) => {
  beforeEach(() => {
    late = lateSession;
  });

  describe("first visit (nothing saved): the pick lands with the read", () => {
    it.each([
      ["no default: the first location", null, [5, 1], 5],
      ["a default in the list: the default", 3, [1, 3], 3],
      ["a default NOT in the list: the first location", 99, [5, 1], 5],
    ])("%s — no render shows a loaded list with nothing selected", async (_what, def, ids, picked) => {
      session = signedIn(def);
      await start();
      await answer(0, ok(ids));

      expect(latest?.selectedLocationId).toBe(picked);
      expect(gapRenders()).toEqual([]);
      // The very render that says "loaded" already names the pick.
      const firstLoaded = snaps.find((s) => !s.isLoading);
      expect(firstLoaded).toEqual({ isLoading: false, loadFailed: false, count: ids.length, selected: picked });
      expect(window.localStorage.getItem(KEY)).toBe(String(picked));
      expect(mockWarning).not.toHaveBeenCalled();
      expect(mockPlainToast).not.toHaveBeenCalled();
    });

    it("after a refused first read, the Retry's answer lands with the pick too", async () => {
      session = signedIn(3);
      await start();
      await answer(0, refused());
      expect(latest?.loadFailed).toBe(true);
      expect(latest?.selectedLocationId).toBeNull();

      await retry();
      await answer(1, ok([1, 3]));
      expect(latest?.selectedLocationId).toBe(3);
      expect(gapRenders()).toEqual([]);
    });

    it("the Fulfill dialog, open while the read is in flight, is seeded with the pick: `Fulfill 1 line from …`", async () => {
      validationAnswersFor();
      await start(
        <FulfillOrderDialog order={ORDER} open onOpenChange={jest.fn()} onSuccess={jest.fn()} csrfToken="t" />
      );
      // The dialog's own list has answered; the operator's location has not.
      await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
      expect(latest?.isLoading).toBe(true);
      expect(fulfilAction()).toHaveTextContent(/^Select a location$/);

      await answer(0, ok([1, 2, 3]));
      expect(latest?.selectedLocationId).toBe(1);
      await waitFor(() => expect(fulfilAction()).toHaveTextContent(/^Fulfill 1 line from Annex$/));
      expect(screen.getByRole("combobox")).toHaveTextContent("Annex");
      expect(fulfilAction()).toBeEnabled();
    });
  });

  describe("a saved id: the pick never replaces it", () => {
    it("a saved id in the list is kept — never the default, never the first, not for one render", async () => {
      window.localStorage.setItem(KEY, "2");
      session = signedIn(1);
      await start();
      await answer(0, ok([1, 2, 3]));

      expect(latest?.selectedLocationId).toBe(2);
      expect(published()).not.toContain(1);
      expect(published()).not.toContain(3);
      expect(published().slice(0, published().indexOf(2)).every((id) => id === null)).toBe(true);
      expect(window.localStorage.getItem(KEY)).toBe("2");
      expect(mockWarning).not.toHaveBeenCalled();
    });

    it("the Fulfill dialog, open while the read is in flight, is seeded with the SAVED id", async () => {
      window.localStorage.setItem(KEY, "2");
      validationAnswersFor();
      await start(
        <FulfillOrderDialog order={ORDER} open onOpenChange={jest.fn()} onSuccess={jest.fn()} csrfToken="t" />
      );
      await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
      expect(fulfilAction()).toHaveTextContent(/^Select a location$/);

      await answer(0, ok([1, 2, 3]));
      await waitFor(() => expect(fulfilAction()).toHaveTextContent(/^Fulfill 1 line from Main$/));
    });

    it("a STALE saved id stays → null and the warning once — the pick (default or first) is never published", async () => {
      window.localStorage.setItem(KEY, "9");
      session = signedIn(1);
      await start();
      await answer(0, ok([1, 3]));

      expect(latest?.selectedLocationId).toBeNull();
      expect(published().every((id) => id === null)).toBe(true);
      expect(mockWarning).toHaveBeenCalledTimes(1);
      expect(mockWarning).toHaveBeenCalledWith(STALE_WARNING);
      expect(window.localStorage.getItem(KEY)).toBe("9");
    });
  });

  describe("awaiting a choice: never auto-filled", () => {
    it("after a discard, a later successful read leaves nothing selected — with no second warning", async () => {
      window.localStorage.setItem(KEY, "9");
      session = signedIn(1);
      await start();
      await answer(0, ok([1, 3]));
      expect(latest?.selectedLocationId).toBeNull();
      expect(mockWarning).toHaveBeenCalledTimes(1);

      await retry();
      await answer(1, ok([1, 3]));
      expect(latest?.isLoading).toBe(false);
      expect(latest?.selectedLocationId).toBeNull();
      expect(published().every((id) => id === null)).toBe(true);
      expect(mockWarning).toHaveBeenCalledTimes(1);

      // The operator's own choice is what fills it.
      await act(async () => {
        latest!.setSelectedLocationId(3);
      });
      expect(latest?.selectedLocationId).toBe(3);
    });
  });
});
