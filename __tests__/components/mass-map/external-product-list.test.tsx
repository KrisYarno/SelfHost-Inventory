/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom can't measure DOM so the real virtualizer reports 0 visible items.
// Stub it to render every item — this test cares about list logic, not the
// virtualization mechanism (which is a third-party library).
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

import { ExternalProductList } from "@/components/products/mass-map/external-product-list";
import type { CatalogRow } from "@/types/bulk-map";

const rows: CatalogRow[] = [
  { externalProductId: "1", externalVariantId: "11", parentTitle: "Coffee Beans", variantTitle: "1 lb", sku: "CB1", type: "variation", attributes: [], alreadyMapped: false },
  { externalProductId: "1", externalVariantId: "12", parentTitle: "Coffee Beans", variantTitle: "5 lb", sku: "CB5", type: "variation", attributes: [], alreadyMapped: true, existingMapping: { linkId: "L", internalProductId: 2, internalProductName: "Coffee Beans 5 lb", isBundle: false, componentCount: null } },
  { externalProductId: "2", externalVariantId: null, parentTitle: "Mug", variantTitle: null, sku: "MUG", type: "simple", attributes: [], alreadyMapped: false },
];

describe("ExternalProductList", () => {
  it("groups rows under a parent header", () => {
    render(
      <ExternalProductList
        rows={rows}
        activeRowKey={null}
        savingKey={null}
        errorKey={null}
        onRowSelect={jest.fn()}
      />,
    );
    // "Coffee Beans" appears once as parent header (variation rows show the variantTitle)
    expect(screen.getByText("Coffee Beans")).toBeInTheDocument();
    // "Mug" appears twice — once as header, once as the simple-product row title
    expect(screen.getAllByText("Mug")).toHaveLength(2);
    expect(screen.getByText("1 lb")).toBeInTheDocument();
    expect(screen.getByText("5 lb")).toBeInTheDocument();
  });

  it("calls onRowSelect when a row is clicked", async () => {
    const user = userEvent.setup();
    const onRowSelect = jest.fn();
    render(
      <ExternalProductList
        rows={rows}
        activeRowKey={null}
        savingKey={null}
        errorKey={null}
        onRowSelect={onRowSelect}
      />,
    );
    await user.click(screen.getByText("1 lb"));
    expect(onRowSelect).toHaveBeenCalledWith(expect.objectContaining({ externalVariantId: "11" }));
  });

  it("shows mapped-row caption with internal product name", () => {
    render(
      <ExternalProductList
        rows={rows}
        activeRowKey={null}
        savingKey={null}
        errorKey={null}
        onRowSelect={jest.fn()}
      />,
    );
    expect(screen.getByText(/Coffee Beans 5 lb/)).toBeInTheDocument();
  });
});
