/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { useInventoryLogs, useInventoryTransfers } from "@/hooks/use-inventory-activity";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

test("logs hook hits /api/inventory/logs?pageSize=20 and returns logs", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ logs: [{ id: 1 }] }) })) as unknown as typeof fetch;
  const { result } = renderHook(() => useInventoryLogs(), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("/api/inventory/logs?pageSize=20");
  expect(result.current.data).toEqual([{ id: 1 }]);
});

test("transfers hook hits /api/inventory/transfers?pageSize=20 and defaults to []", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  const { result } = renderHook(() => useInventoryTransfers(), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("/api/inventory/transfers?pageSize=20");
  expect(result.current.data).toEqual([]);
});
