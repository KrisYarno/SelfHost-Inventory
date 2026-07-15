/** @jest-environment jsdom */
//
// W0-RETAIL client writer coverage (spec §4 W0-RETAIL): the product form must
// send retailPrice = NULL for a blank field ("unknown"), NEVER a coerced 0, and
// must preserve an explicit 0 (genuinely free). This locks the form-level
// sanitize that the old `Number.isFinite(...) ? ... : 0` coercion broke — a
// blank field used to be shipped to the API as $0.00.

import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("@/hooks/use-low-stock-default", () => ({
  useLowStockDefault: () => 10,
}));

import { ProductForm } from "@/components/products/product-form";

function fill(labelText: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(labelText), { target: { value } });
}

describe("ProductForm — retail NULL preservation (client writer)", () => {
  it("create: a blank retail field submits retailPrice = null (never 0)", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<ProductForm onSubmit={onSubmit} onCancel={() => {}} />);

    // Variant-only product (no numeric size) — leaves retail untouched/blank.
    fill(/product name/i, "BPC");
    fill(/variant label/i, "Vial");
    fireEvent.click(screen.getByRole("button", { name: /create product/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].retailPrice).toBeNull();
  });

  it("edit: a product with NULL retail submits retailPrice = null (does not re-materialize 0)", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const product = {
      id: 1,
      baseName: "BPC",
      variant: "Vial",
      unit: null,
      numericValue: null,
      costPrice: null,
      retailPrice: null,
      lowStockThreshold: null,
    } as any;
    render(<ProductForm product={product} onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /update product/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].retailPrice).toBeNull();
  });

  it("edit: an explicit 0 retail is preserved as genuinely free (distinct from null)", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const product = {
      id: 2,
      baseName: "BPC",
      variant: "Vial",
      unit: null,
      numericValue: null,
      costPrice: null,
      retailPrice: 0,
      lowStockThreshold: null,
    } as any;
    render(<ProductForm product={product} onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /update product/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].retailPrice).toBe(0);
  });
});
