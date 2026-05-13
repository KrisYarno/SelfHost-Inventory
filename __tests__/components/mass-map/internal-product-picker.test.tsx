/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InternalProductPicker } from "@/components/products/mass-map/internal-product-picker";
import type { CatalogRow, InternalProductIndexEntry } from "@/types/bulk-map";

const row: CatalogRow = {
  externalProductId: "10",
  externalVariantId: "101",
  parentTitle: "Coffee Beans",
  variantTitle: "1 lb",
  sku: "CB1",
  type: "variation",
  attributes: [{ name: "Size", option: "1lb" }],
  alreadyMapped: false,
};

const index: InternalProductIndexEntry[] = [
  {
    id: 1,
    name: "Coffee Beans 1 lb",
    baseName: "Coffee Beans",
    variant: "1 lb",
    numericValue: 1,
    unit: "lb",
    hasAnyMapping: false,
    baseNameTokens: ["coffee", "beans"],
  },
  {
    id: 2,
    name: "Coffee Beans 5 lb",
    baseName: "Coffee Beans",
    variant: "5 lb",
    numericValue: 5,
    unit: "lb",
    hasAnyMapping: true,
    baseNameTokens: ["coffee", "beans"],
  },
];

function wrapper({ children }: { children: React.ReactNode }) {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={c}>{children}</QueryClientProvider>;
}

describe("InternalProductPicker", () => {
  it("renders the empty prompt when no row is active", () => {
    render(
      <InternalProductPicker
        row={null}
        index={index}
        indexLoading={false}
        saving={false}
        errorMessage={null}
        successFor={null}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        onFinishSuccess={jest.fn()}
        onKeepSuccess={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByText(/Pick a row from the list to map it/i)).toBeInTheDocument();
  });

  it("renders suggestions with reason badges, greys already-mapped ones", () => {
    render(
      <InternalProductPicker
        row={row}
        index={index}
        indexLoading={false}
        saving={false}
        errorMessage={null}
        successFor={null}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        onFinishSuccess={jest.fn()}
        onKeepSuccess={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByText(/title \+ size/i)).toBeInTheDocument();
    expect(screen.getByText(/Coffee Beans 5 lb/)).toBeInTheDocument();
    expect(screen.getByText(/Already mapped/i)).toBeInTheDocument();
  });

  it("enables Confirm only after a selection", async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    render(
      <InternalProductPicker
        row={row}
        index={index}
        indexLoading={false}
        saving={false}
        errorMessage={null}
        successFor={null}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
        onFinishSuccess={jest.fn()}
        onKeepSuccess={jest.fn()}
      />,
      { wrapper },
    );
    const confirm = screen.getByRole("button", { name: /Confirm mapping/i });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByText(/Coffee Beans 1 lb/));
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("shows an error message and keeps Confirm enabled with the previous selection", () => {
    render(
      <InternalProductPicker
        row={row}
        index={index}
        indexLoading={false}
        saving={false}
        errorMessage="Save failed — try again"
        successFor={null}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        onFinishSuccess={jest.fn()}
        onKeepSuccess={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByText(/Save failed/)).toBeInTheDocument();
  });

  it("mounts the success panel when successFor is set", () => {
    render(
      <InternalProductPicker
        row={row}
        index={index}
        indexLoading={false}
        saving={false}
        errorMessage={null}
        successFor={{ row, internalProductName: "Coffee Beans 1 lb" }}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        onFinishSuccess={jest.fn()}
        onKeepSuccess={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByText(/Mapped successfully/i)).toBeInTheDocument();
  });
});
