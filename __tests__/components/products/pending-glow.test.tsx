/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { ProductCard } from "@/components/products/product-card";
import type { ProductWithQuantity } from "@/types/product";
import type { ProductApprovalStatus } from "@prisma/client";

const createMockProduct = (
  approvalStatus: ProductApprovalStatus
): ProductWithQuantity => ({
  id: 1,
  name: "Test Product",
  baseName: "Test",
  variant: "Variant",
  unit: "EA",
  numericValue: null,
  quantity: 5,
  location: 1,
  lowStockThreshold: 10,
  deletedAt: null,
  deletedBy: null,
  costPrice: 0 as any,
  retailPrice: 0 as any,
  priceSourceLinkId: null,
  approvalStatus,
  createdBy: null,
  reviewedBy: null,
  reviewedAt: null,
  currentQuantity: 5,
});

describe("ProductCard pending-review glow", () => {
  it("renders the amber glow + 'Pending review' aria-label when approvalStatus is PENDING_REVIEW", () => {
    render(<ProductCard product={createMockProduct("PENDING_REVIEW")} />);

    const card = screen.getByLabelText("Pending review");
    expect(card).toBeInTheDocument();
    expect(card).toHaveAttribute("title", "Pending review");
    // Soft amber box-shadow glow applied via inline style (zero layout shift).
    expect(card.style.boxShadow).toContain("rgba(245,158,11");
    expect(card.style.boxShadow).toContain("245,158,11,0.55");
  });

  it("renders NO glow and NO 'Pending review' affordance when approvalStatus is APPROVED", () => {
    const { container } = render(
      <ProductCard product={createMockProduct("APPROVED")} />
    );

    expect(screen.queryByLabelText("Pending review")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Pending review")).not.toBeInTheDocument();

    // No inline amber box-shadow on the card root.
    const cardRoot = container.firstElementChild as HTMLElement;
    expect(cardRoot.style.boxShadow).toBe("");
  });
});
