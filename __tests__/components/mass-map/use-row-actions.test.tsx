/** @jest-environment jsdom */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useRowActions } from "@/components/products/mass-map/use-row-actions";
import type { CatalogResponse, CatalogRow } from "@/types/bulk-map";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "csrf-token" }),
}));

const row: CatalogRow = {
  externalProductId: "10",
  externalVariantId: "101",
  parentTitle: "Coffee Beans",
  variantTitle: "1 lb",
  sku: "CB1",
  type: "variation",
  attributes: [],
  alreadyMapped: false,
};

function buildClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData<CatalogResponse>(["bulk-map-catalog", "intA"], {
    integration: {
      id: "intA",
      name: "Main",
      platform: "WOOCOMMERCE",
      storeUrl: "https://s",
    },
    rows: [row],
    fetchedAt: new Date().toISOString(),
    warnings: [],
  });
  return client;
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <Toaster />
      {children}
    </QueryClientProvider>
  );
}

describe("useRowActions", () => {
  beforeEach(() => {
    (global.fetch as unknown as jest.Mock) = jest.fn();
  });

  it("optimistically marks mapped, reverts on error", async () => {
    const client = buildClient();
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    });
    const { result } = renderHook(() => useRowActions(), { wrapper: wrapper(client) });

    await expect(
      result.current.confirm({
        integrationId: "intA",
        row,
        internalProductId: 7,
        internalProductName: "Coffee Beans 1 lb",
      }),
    ).rejects.toThrow();

    const data = client.getQueryData<CatalogResponse>(["bulk-map-catalog", "intA"])!;
    expect(data.rows[0].alreadyMapped).toBe(false);
    expect(data.rows[0].existingMapping).toBeUndefined();
  });

  it("on 409 conflict, refreshes mappings-only and keeps the new state", async () => {
    const client = buildClient();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "already mapped" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          mappings: [
            {
              id: "linkX",
              externalProductId: "10",
              externalVariantId: "101",
              internalProductId: 99,
              internalProduct: { name: "Other Internal" },
            },
          ],
        }),
      });

    const { result } = renderHook(() => useRowActions(), { wrapper: wrapper(client) });

    await expect(
      result.current.confirm({
        integrationId: "intA",
        row,
        internalProductId: 7,
        internalProductName: "Coffee Beans 1 lb",
      }),
    ).rejects.toThrow(/already mapped by another session/);

    await waitFor(() => {
      const data = client.getQueryData<CatalogResponse>(["bulk-map-catalog", "intA"])!;
      expect(data.rows[0].alreadyMapped).toBe(true);
      expect(data.rows[0].existingMapping?.linkId).toBe("linkX");
    });
  });

  it("on success, sets the final linkId from server response", async () => {
    const client = buildClient();
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: "newLink123" }),
    });
    const { result } = renderHook(() => useRowActions(), { wrapper: wrapper(client) });

    let linkId: string | undefined;
    await act(async () => {
      linkId = await result.current.confirm({
        integrationId: "intA",
        row,
        internalProductId: 7,
        internalProductName: "Coffee Beans 1 lb",
      });
    });

    expect(linkId).toBe("newLink123");
    const data = client.getQueryData<CatalogResponse>(["bulk-map-catalog", "intA"])!;
    expect(data.rows[0].alreadyMapped).toBe(true);
    expect(data.rows[0].existingMapping?.linkId).toBe("newLink123");
  });

  it("undo rolls back the optimistic revert when DELETE fails", async () => {
    const client = buildClient();
    const priorMapping = {
      linkId: "newLink123",
      internalProductId: 7,
      internalProductName: "Coffee Beans 1 lb",
      isBundle: false,
      componentCount: null,
    };
    client.setQueryData<CatalogResponse>(["bulk-map-catalog", "intA"], (prev) => ({
      ...prev!,
      rows: [{ ...row, alreadyMapped: true, existingMapping: priorMapping }],
    }));

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const { result } = renderHook(() => useRowActions(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.undo({
        integrationId: "intA",
        row,
        linkId: "newLink123",
      });
    });

    // Server still has the mapping, so the UI should still show it as mapped.
    const data = client.getQueryData<CatalogResponse>(["bulk-map-catalog", "intA"])!;
    expect(data.rows[0].alreadyMapped).toBe(true);
    expect(data.rows[0].existingMapping).toEqual(priorMapping);
  });

  it("undo reverts the row and calls DELETE", async () => {
    const client = buildClient();
    client.setQueryData<CatalogResponse>(["bulk-map-catalog", "intA"], (prev) => ({
      ...prev!,
      rows: [
        {
          ...row,
          alreadyMapped: true,
          existingMapping: {
            linkId: "newLink123",
            internalProductId: 7,
            internalProductName: "Coffee Beans 1 lb",
            isBundle: false,
            componentCount: null,
          },
        },
      ],
    }));

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const { result } = renderHook(() => useRowActions(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.undo({
        integrationId: "intA",
        row,
        linkId: "newLink123",
      });
    });

    const data = client.getQueryData<CatalogResponse>(["bulk-map-catalog", "intA"])!;
    expect(data.rows[0].alreadyMapped).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/admin/product-mappings?linkId=newLink123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
