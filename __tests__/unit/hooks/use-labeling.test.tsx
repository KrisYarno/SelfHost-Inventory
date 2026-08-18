/** @jest-environment jsdom */
/**
 * `hooks/use-labeling.ts` — THE QUEUE'S READ (contract pack C5.1).
 *
 * What this file holds still is the SCOPE. `?orderId=` is a deep link from an
 * order detail, and its absence is the whole queue — but a URL can carry the
 * parameter with nothing in it, and a form can hand the component an empty
 * string. `""` is not a filter on the order whose id is the empty string; it is
 * the absence of a filter, and reading it as anything else gave the SAME
 * request two cache entries (`["labeling","queue",""]` beside
 * `["labeling","queue","all"]`) — two copies of one list, invalidated together
 * and refetched separately, disagreeing for as long as both stay mounted.
 */

import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useLabelingQueue, labelingScope } from "@/hooks/use-labeling";
import { labelingKeys } from "@/hooks/use-labeling-keys";

const EMPTY_QUEUE = { groups: [], count: 0, moreCount: 0 };

const mockFetch = jest.fn();
let queryClient: QueryClient;

function wrapper() {
  function Harness({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Harness;
}

beforeEach(() => {
  jest.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => EMPTY_QUEUE,
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;
});

function keys(): string[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify(query.queryKey));
}

it("QA-9: an EMPTY orderId is the whole queue — ONE cache entry, one URL", async () => {
  const unfiltered = renderHook(() => useLabelingQueue(undefined), { wrapper: wrapper() });
  await waitFor(() => expect(unfiltered.result.current.isSuccess).toBe(true));

  const blank = renderHook(() => useLabelingQueue(""), { wrapper: wrapper() });
  await waitFor(() => expect(blank.result.current.isSuccess).toBe(true));

  expect(keys()).toEqual([JSON.stringify(labelingKeys.queue())]);
  expect(
    mockFetch.mock.calls.every((call) => String(call[0]) === "/api/labeling/queue"),
  ).toBe(true);
});

it("a real orderId still scopes the key and the URL", async () => {
  const scoped = renderHook(() => useLabelingQueue("ord_1"), { wrapper: wrapper() });
  await waitFor(() => expect(scoped.result.current.isSuccess).toBe(true));

  expect(keys()).toEqual([JSON.stringify(labelingKeys.queue("ord_1"))]);
  expect(String(mockFetch.mock.calls[0][0])).toBe("/api/labeling/queue?orderId=ord_1");
});

it("labelingScope is the ONE reading of that rule", () => {
  expect(labelingScope(undefined)).toBeUndefined();
  expect(labelingScope("")).toBeUndefined();
  expect(labelingScope("   ")).toBeUndefined();
  expect(labelingScope("ord_1")).toBe("ord_1");
});
