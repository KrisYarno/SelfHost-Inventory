/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductCard } from "@/components/products/product-card";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

// Radix dropdown relies on pointer-capture + scrollIntoView, neither of which
// jsdom implements. Polyfill them so the menu can open under userEvent.
beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

const product: any = {
  id: 42, name: "Widget", baseName: "Widget", variant: null,
  currentQuantity: 5, lowStockThreshold: 10, approvalStatus: "APPROVED",
  costPrice: 0, retailPrice: 0,
};

test("product card exposes a 'View analytics' action to /analytics/product/[id]", async () => {
  const user = userEvent.setup();
  render(
    <ProductCard
      product={product}
      isAdmin
      showInventoryActions
      onEdit={() => {}}
    />
  );
  // The action lives inside the dropdown menu, closed/portalled by default.
  // userEvent dispatches the full pointer sequence Radix needs to open it.
  await user.click(screen.getByRole("button", { name: /open menu/i }));
  const link = await screen.findByRole("menuitem", { name: /view analytics/i });
  expect(link).toHaveAttribute("href", "/analytics/product/42");
});
