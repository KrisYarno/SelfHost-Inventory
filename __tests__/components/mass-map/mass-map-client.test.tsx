/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "x", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "x" }),
}));

// Virtualizer can't measure in jsdom; render every item.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => {
    let offset = 0;
    const items = Array.from({ length: count }, (_, i) => {
      const size = estimateSize(i);
      const start = offset;
      offset += size;
      return { index: i, start, size, key: i };
    });
    return {
      getVirtualItems: () => items,
      getTotalSize: () => offset,
    };
  },
}));

import { MassMapClient } from "@/components/products/mass-map/mass-map-client";
import type { CatalogResponse } from "@/types/bulk-map";

function seed(client: QueryClient) {
  const data: CatalogResponse = {
    integration: { id: "i1", name: "Main", platform: "WOOCOMMERCE", storeUrl: "https://s" },
    rows: [
      { externalProductId: "1", externalVariantId: null, parentTitle: "Mug", variantTitle: null, sku: "MUG", type: "simple", attributes: [], alreadyMapped: false },
      { externalProductId: "2", externalVariantId: null, parentTitle: "Hat", variantTitle: null, sku: "HAT", type: "simple", attributes: [], alreadyMapped: true, existingMapping: { linkId: "L", internalProductId: 7, internalProductName: "Hat Internal" } },
    ],
    fetchedAt: new Date().toISOString(),
    warnings: [],
  };
  client.setQueryData(["bulk-map-catalog", "i1"], data);
  client.setQueryData(["bulk-map-internal-products"], []);
}

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return (
    <QueryClientProvider client={client}>
      <MassMapClient integrationId="i1" />
    </QueryClientProvider>
  );
}

describe("MassMapClient", () => {
  it("renders unmapped count and mapped count on the tabs", () => {
    render(harness());
    expect(screen.getByRole("tab", { name: /Unmapped/i })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /^Mapped/i })).toHaveTextContent("1");
  });

  it("switches to the Mapped tab and shows the mapped row", async () => {
    const user = userEvent.setup();
    render(harness());
    await user.click(screen.getByRole("tab", { name: /^Mapped/i }));
    // "Hat" appears twice — once as header, once as the simple-product row title
    expect(screen.getAllByText("Hat").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the warnings banner when warnings are present", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData<CatalogResponse>(["bulk-map-catalog", "i1"], {
      integration: { id: "i1", name: "Main", platform: "WOOCOMMERCE", storeUrl: "https://s" },
      rows: [],
      fetchedAt: new Date().toISOString(),
      warnings: [
        { kind: "variations-failed", productId: "10", parentTitle: "Coffee Beans", message: "boom" },
      ],
    });
    client.setQueryData(["bulk-map-internal-products"], []);
    render(
      <QueryClientProvider client={client}>
        <MassMapClient integrationId="i1" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Partial catalog/i)).toBeInTheDocument();
  });
});
