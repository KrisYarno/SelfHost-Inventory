/** @jest-environment jsdom */
/**
 * `hooks/use-product-location-version.ts` — THE COUNT'S VERSION READ
 * (reconciliation Part 2, pack § P2-B3-2 C2-5; seam S-B24).
 *
 * The Adjust stock dialog's Count sends the row version this hook read; the
 * server books the count only while that version is still the row's. So the
 * hook READS ONCE PER OPEN and never re-reads on its own: a re-read under a
 * count already typed would check that count against a version the operator
 * never saw. Pinned against a REAL QueryClient (react-query's own defaults —
 * focus and reconnect refetching ON, a 5 min gcTime), with only `fetch` mocked:
 *
 *   - one GET per mount across `enabled` false → true → false → true;
 *   - no GET on a window-focus event, nor on offline → online — even with the
 *     cached answer marked stale, so each option is load-bearing on its own
 *     and not hidden behind `staleTime: Infinity`;
 *   - `refetch()` issues a GET; unmount then remount → a new GET (`gcTime: 0`);
 *   - `fetchStatus` is "fetching" during a refetch while `data` still holds the
 *     old answer (why "in flight" is never `status === "pending"`);
 *   - `null` for a location absent from the answer; a non-2xx → "error".
 */
import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { useProductLocationVersion } from "@/hooks/use-product-location-version";

const URL_42 = "/api/inventory/product/42/locations";

/** What `/locations` answers: Office (2) and Bench (5). */
let office = { quantity: 7, version: 3 };
let answerOk = true;
const fetchMock = jest.fn(async (_url: unknown, _init?: unknown) => {
  if (!answerOk) return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as unknown as Response;
  const body = {
    productId: 42,
    productName: "AOD 2mg",
    locations: [
      { locationId: 2, locationName: "Office", ...office },
      { locationId: 5, locationName: "Bench", quantity: 0, version: 0 },
    ],
  };
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
});

let client: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const gets = () => fetchMock.mock.calls.filter((c) => String(c[0]) === URL_42).length;

beforeEach(() => {
  office = { quantity: 7, version: 3 };
  answerOk = true;
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  onlineManager.setOnline(true);
  // react-query's OWN defaults, except no retry (an error must settle at once):
  // focus and reconnect refetching are ON here, so the hook's options are what
  // the pins below are about.
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await client.cancelQueries();
  client.clear();
  onlineManager.setOnline(true);
});

type Props = { locationId: number | null; enabled: boolean };
function renderVersion(initial: Props) {
  return renderHook(
    ({ locationId, enabled }: Props) => useProductLocationVersion(42, locationId, { enabled }),
    { wrapper, initialProps: initial },
  );
}

describe("useProductLocationVersion", () => {
  it("reads the product's `/locations` route under its own key, and answers `{ quantity, version }` for the location", async () => {
    const { result } = renderVersion({ locationId: 2, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.data).toEqual({ quantity: 7, version: 3 });
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(URL_42);
    expect(client.getQueryCache().find({ queryKey: ["product-location-version", 42, 2] })).toBeDefined();
  });

  it("a never-stocked location reads as the route synthesises it: `{ 0, 0 }`, not null", async () => {
    const { result } = renderVersion({ locationId: 5, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.data).toEqual({ quantity: 0, version: 0 });
  });

  it("`null` for a location ABSENT from the answer", async () => {
    const { result } = renderVersion({ locationId: 99, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.data).toBeNull();
  });

  it("a non-2xx answer → `status: \"error\"` (never a number)", async () => {
    answerOk = false;
    const { result } = renderVersion({ locationId: 2, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.data).toBeUndefined();
  });

  it("no GET while disabled, nor with no location", async () => {
    renderVersion({ locationId: 2, enabled: false });
    renderVersion({ locationId: null, enabled: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ONE GET per mount across `enabled` false → true → false → true (the server's answer changing meanwhile)", async () => {
    const { result, rerender } = renderVersion({ locationId: 2, enabled: false });
    expect(gets()).toBe(0);

    rerender({ locationId: 2, enabled: true });
    await waitFor(() => expect(result.current.data).toEqual({ quantity: 7, version: 3 }));
    expect(gets()).toBe(1);

    office = { quantity: 6, version: 4 };
    rerender({ locationId: 2, enabled: false });
    rerender({ locationId: 2, enabled: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gets()).toBe(1);
    // The token on screen is still the first read's.
    expect(result.current.data).toEqual({ quantity: 7, version: 3 });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("no GET on a window-focus event — even with the cached answer marked stale", async () => {
    const { result } = renderVersion({ locationId: 2, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("success"));

    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    // Stale by invalidation (no refetch from the invalidation itself): only
    // `refetchOnWindowFocus: false` now stands between a focus and a re-read.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["product-location-version"], refetchType: "none" });
    });
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gets()).toBe(1);
  });

  it("no GET on `onlineManager` offline → online — even with the cached answer marked stale", async () => {
    const { result } = renderVersion({ locationId: 2, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("success"));

    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    // As above: only `refetchOnReconnect: false` (the app default is ON) stands
    // between a reconnect and a re-read.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["product-location-version"], refetchType: "none" });
    });
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gets()).toBe(1);
  });

  it("`refetch()` issues a GET and answers the NEW read", async () => {
    const { result } = renderVersion({ locationId: 2, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("success"));
    // (Read here, so react-query's tracked result re-renders when they change.)
    expect(result.current.data).toEqual({ quantity: 7, version: 3 });
    office = { quantity: 6, version: 4 };

    let next: Awaited<ReturnType<typeof result.current.refetch>> | undefined;
    await act(async () => {
      next = await result.current.refetch();
    });
    expect(gets()).toBe(2);
    expect(next?.status).toBe("success");
    expect(next?.data).toEqual({ quantity: 6, version: 4 });
    await waitFor(() => expect(result.current.data).toEqual({ quantity: 6, version: 4 }));
  });

  it("unmount, then mount again → a NEW GET (`gcTime: 0`: no token outlives the open)", async () => {
    const first = renderVersion({ locationId: 2, enabled: true });
    await waitFor(() => expect(first.result.current.status).toBe("success"));
    first.unmount();
    // Collected at once, not after react-query's default five minutes.
    await waitFor(() =>
      expect(client.getQueryCache().find({ queryKey: ["product-location-version", 42, 2] })).toBeUndefined(),
    );

    office = { quantity: 6, version: 4 };
    const second = renderVersion({ locationId: 2, enabled: true });
    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => expect(second.result.current.data).toEqual({ quantity: 6, version: 4 }));
    expect(gets()).toBe(2);
  });

  it("during a refetch `fetchStatus` is \"fetching\" while `data` still holds the OLD answer (and `status` stays \"success\")", async () => {
    const { result } = renderVersion({ locationId: 2, enabled: true });
    await waitFor(() => expect(result.current.status).toBe("success"));
    // (Read here, so react-query's tracked result re-renders when they change.)
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toEqual({ quantity: 7, version: 3 });

    let release!: () => void;
    const answerAsUsual = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(
      (url: unknown, init?: unknown) =>
        new Promise<Response>((resolve) => {
          release = () => {
            office = { quantity: 6, version: 4 };
            void answerAsUsual(url, init).then(resolve);
          };
        }),
    );

    let refetching!: Promise<unknown>;
    act(() => {
      refetching = result.current.refetch();
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe("fetching"));
    expect(result.current.status).toBe("success");
    expect(result.current.data).toEqual({ quantity: 7, version: 3 });

    await act(async () => {
      release();
      await refetching;
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(result.current.data).toEqual({ quantity: 6, version: 4 });
  });
});
