/** @jest-environment jsdom */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// CSRF token present so the dialog's csrf gate passes.
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({
    ...h,
    "x-csrf-token": "test-csrf",
  }),
}));

import { GraduateDialog } from "@/components/staging/graduate-dialog";

const ITEM = {
  id: 42,
  description: "Unlabeled box of vials",
  expectedQuantity: null,
  locationId: 1,
};

const LOCATIONS = [
  { id: 1, name: "Main Warehouse" },
  { id: 2, name: "Back Room" },
];

function mockFetchEmpty() {
  // Product search + duplicate-name checks resolve to an empty product list.
  global.fetch = jest.fn(async () =>
    ({
      ok: true,
      json: async () => ({ products: [] }),
    } as unknown as Response)
  ) as unknown as typeof fetch;
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof GraduateDialog>> = {}) {
  return render(
    <GraduateDialog
      open
      onOpenChange={jest.fn()}
      item={ITEM}
      locations={LOCATIONS}
      onSuccess={jest.fn()}
      {...overrides}
    />
  );
}

describe("GraduateDialog", () => {
  beforeEach(() => {
    mockFetchEmpty();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("toggling Existing/New swaps the body", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Existing mode (default): product search input is present, ProductForm is not.
    expect(screen.getByPlaceholderText(/search products/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/product name/i)).not.toBeInTheDocument();

    // Switch to New: ProductForm's "Product Name" field appears, search disappears.
    await user.click(screen.getByRole("button", { name: /new product/i }));
    expect(screen.getByLabelText(/product name/i)).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/search products/i)
    ).not.toBeInTheDocument();

    // Switch back to Existing.
    await user.click(screen.getByRole("button", { name: /existing product/i }));
    expect(screen.getByPlaceholderText(/search products/i)).toBeInTheDocument();
  });

  it("Existing: Confirm is disabled until counted qty >= 1 AND a product is chosen", async () => {
    const user = userEvent.setup();
    // Return a product so it can be selected from the search results.
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      const products = u.includes("search=")
        ? [{ id: 7, name: "BPC-157 5mg", approvalStatus: "APPROVED" }]
        : [];
      return {
        ok: true,
        json: async () => ({ products }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    renderDialog();

    const confirm = screen.getByRole("button", { name: /confirm/i });
    // No qty, no product -> disabled.
    expect(confirm).toBeDisabled();

    // Enter a valid counted quantity. Still no product selected -> disabled.
    await user.type(screen.getByLabelText(/counted quantity/i), "5");
    expect(confirm).toBeDisabled();

    // Search and select a product.
    await user.type(screen.getByPlaceholderText(/search products/i), "bpc");
    const result = await screen.findByRole("button", { name: /BPC-157 5mg/i });
    await user.click(result);

    // Now qty >= 1 AND a product is chosen -> enabled.
    await waitFor(() => expect(confirm).not.toBeDisabled());
  });

  it("Existing: a counted qty of 0 keeps Confirm disabled even with a product chosen", async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      const products = u.includes("search=")
        ? [{ id: 7, name: "BPC-157 5mg", approvalStatus: "APPROVED" }]
        : [];
      return {
        ok: true,
        json: async () => ({ products }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    renderDialog();

    const confirm = screen.getByRole("button", { name: /confirm/i });
    await user.type(screen.getByLabelText(/counted quantity/i), "0");
    await user.type(screen.getByPlaceholderText(/search products/i), "bpc");
    const result = await screen.findByRole("button", { name: /BPC-157 5mg/i });
    await user.click(result);

    // qty < 1 -> still disabled.
    expect(confirm).toBeDisabled();
  });

  it("New: the create button is disabled until counted qty >= 1 AND required fields are filled", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /new product/i }));

    // ProductForm's submit button (the Confirm for the New branch).
    const createBtn = screen.getByRole("button", { name: /create product/i });

    // No counted qty yet -> disabled regardless of fields.
    expect(createBtn).toBeDisabled();

    // Enter counted qty. disableSubmit on ProductForm releases.
    await user.type(screen.getByLabelText(/counted quantity/i), "3");
    await waitFor(() => expect(createBtn).not.toBeDisabled());

    // Fill the required identity fields (baseName + variant label — plain inputs,
    // no Radix Select interaction needed) and submit; a graduate POST fires.
    await user.type(screen.getByLabelText(/product name/i), "Test Peptide");
    await user.type(screen.getByLabelText(/variant label/i), "Vial");
    await user.click(createBtn);

    await waitFor(() => {
      const calls = (global.fetch as jest.Mock).mock.calls.map((c) =>
        String(c[0])
      );
      expect(
        calls.some((u) => u.includes("/api/staging-items/42/graduate"))
      ).toBe(true);
    });
  });
});
