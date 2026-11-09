/** @jest-environment jsdom */
//
// W1-4b RIDE-ALONG — the PAGE-level skipped-lines alert, aligned with the
// W0.5-a dialog's classes (registered divergence, plan run ledger W0.5-a).
//
// W0.5-a taught the COMPLETE dialog that `unmappedExternalItems` mixes three
// different truths. The page-level alert kept the old copy: it called every
// non-bundle line "unmapped" (including lines that ARE mapped but whose product
// was not in the loaded array), and it printed a bundle-only footnote. Two
// surfaces, one array, two stories.
//
// The cure is structural: both surfaces now read the SAME classifier and the
// SAME per-class copy from lib/workbench/skipped-lines.ts, so the next copy
// change cannot land on one of them.
//
// The Map button's semantics are UNCHANGED (admin + a real external reference);
// the alert simply stops rendering it where the handler already refused to act.

import * as React from "react";
import { render, screen, within } from "@testing-library/react";

jest.mock("next-auth/react", () => ({
  useSession: jest.fn(() => ({ data: { user: { isAdmin: true } } })),
}));
jest.mock("@/components/products/product-map-dialog", () => ({
  ProductMapDialog: () => null,
}));

import { useSession } from "next-auth/react";
import { UnmappedItemsAlert } from "@/components/workbench/unmapped-items-alert";
import {
  SKIPPED_LINE_COPY,
  SKIPPED_LINE_LABEL,
} from "@/lib/workbench/skipped-lines";
import { NO_STORE_PRODUCT_LINE_HINT } from "@/lib/orders/catalog-product-id";

// ---------------------------------------------------------------------------
// Fixtures — one line per class, built the way the hook builds them
// ---------------------------------------------------------------------------

/** Never mapped: it carries an external reference and nothing internal. */
const UNMAPPED = {
  name: "Mystery Peptide 5mg",
  sku: "MP-5",
  quantity: 3,
  externalProductId: "wc-101",
};

/** Mapped, but its internal product was not in the loaded products array. */
const UNAVAILABLE = {
  name: "Vial Rack",
  sku: "VR-1",
  quantity: 1,
};

/** Mapped AND a bundle: it ships, just not from the workbench cart. */
const BUNDLE = {
  name: "Starter Kit",
  sku: "KIT-1",
  quantity: 2,
  externalProductId: "wc-909",
  isBundle: true,
};

/**
 * Hand-typed lines plan, C7: lines with NO store product. WooCommerce sends
 * product_id 0 for a line typed by hand in the store; a missing id is "". Both
 * carry `class: "unmapped"` exactly as the hook stamps it
 * (hooks/use-workbench.ts) — a class-less "" line would fall back to the
 * heuristic and classify as unavailable, which is not what the hook sends.
 * Declared as consts so the extra `class` field is accepted.
 */
const HAND_TYPED_ZERO = {
  name: "BAC 5",
  quantity: 2,
  externalProductId: "0",
  class: "unmapped" as const,
};

const HAND_TYPED_EMPTY = {
  name: "Custom line",
  quantity: 1,
  externalProductId: "",
  class: "unmapped" as const,
};

/** A catalog line, stamped the way the hook stamps it. */
const CATALOG_UNMAPPED = {
  name: "Mystery Peptide 10mg",
  sku: "MP-10",
  quantity: 1,
  externalProductId: "wc-102",
  class: "unmapped" as const,
};

/** Mapped but not in the loaded products, stamped the way the hook stamps it. */
const UNAVAILABLE_STAMPED = {
  name: "Vial Rack",
  sku: "VR-1",
  quantity: 1,
  class: "unavailable" as const,
};

const renderAlert = (
  items: React.ComponentProps<typeof UnmappedItemsAlert>["items"],
  props: Partial<React.ComponentProps<typeof UnmappedItemsAlert>> = {},
) =>
  render(
    <UnmappedItemsAlert items={items} integrationId="int-1" {...props} />,
  );

beforeEach(() => {
  jest.clearAllMocks();
  (useSession as jest.Mock).mockReturnValue({ data: { user: { isAdmin: true } } });
});

// ---------------------------------------------------------------------------
// Per-class copy — the same strings the dialog prints
// ---------------------------------------------------------------------------

describe("per-class copy", () => {
  it("prints the truthful line for each of the three classes", () => {
    renderAlert([UNMAPPED, UNAVAILABLE, BUNDLE]);

    expect(screen.getByText(SKIPPED_LINE_COPY.unmapped)).toBeInTheDocument();
    expect(screen.getByText(SKIPPED_LINE_COPY.unavailable)).toBeInTheDocument();
    expect(screen.getByText(SKIPPED_LINE_COPY.bundle)).toBeInTheDocument();
  });

  it("groups the lines under their class label", () => {
    renderAlert([UNMAPPED, UNAVAILABLE, BUNDLE]);

    for (const lineClass of ["unmapped", "unavailable", "bundle"] as const) {
      const group = screen.getByTestId(`skipped-group-${lineClass}`);
      expect(
        within(group).getByText(new RegExp(SKIPPED_LINE_LABEL[lineClass])),
      ).toBeInTheDocument();
    }
  });

  it("renders only the classes that are present", () => {
    renderAlert([BUNDLE]);

    expect(screen.queryByTestId("skipped-group-unmapped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skipped-group-unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("skipped-group-bundle")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The header: bundles are NOT called unmapped
// ---------------------------------------------------------------------------

describe("header summary", () => {
  it("never calls a bundle unmapped", () => {
    renderAlert([BUNDLE]);

    const header = screen.getByTestId("skipped-lines-header");
    expect(header).toHaveTextContent(/bundle/i);
    expect(header).not.toHaveTextContent(/unmapped/i);
  });

  it("never calls a mapped-but-unavailable line unmapped", () => {
    renderAlert([UNAVAILABLE]);

    const header = screen.getByTestId("skipped-lines-header");
    expect(header).not.toHaveTextContent(/unmapped/i);
    expect(header).toHaveTextContent(new RegExp(SKIPPED_LINE_LABEL.unavailable, "i"));
  });

  it("counts each class separately when all three are present", () => {
    renderAlert([UNMAPPED, UNMAPPED, UNAVAILABLE, BUNDLE]);

    const header = screen.getByTestId("skipped-lines-header");
    expect(header).toHaveTextContent(/2 unmapped/i);
    expect(header).toHaveTextContent(new RegExp(`1 ${SKIPPED_LINE_LABEL.unavailable}`, "i"));
    expect(header).toHaveTextContent(/1 bundle/i);
  });

  it("says the lines will not be deducted", () => {
    renderAlert([UNMAPPED]);

    expect(screen.getByTestId("skipped-lines-header")).toHaveTextContent(
      /not be deducted/i,
    );
  });

  it("renders nothing at all for an empty list", () => {
    const { container } = renderAlert([]);
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// Map button — semantics unchanged, rendered only where it can act
// ---------------------------------------------------------------------------

describe("the Map button", () => {
  it("offers Map on a truly-unmapped line for an admin", () => {
    renderAlert([UNMAPPED]);
    expect(screen.getByRole("button", { name: /^map$/i })).toBeInTheDocument();
  });

  it("never offers Map on a bundle (it is already mapped)", () => {
    renderAlert([BUNDLE]);
    expect(screen.queryByRole("button", { name: /^map$/i })).not.toBeInTheDocument();
  });

  it("never offers Map on a mapped-but-unavailable line (nothing to map)", () => {
    renderAlert([UNAVAILABLE]);
    expect(screen.queryByRole("button", { name: /^map$/i })).not.toBeInTheDocument();
  });

  it("never offers Map to a non-admin", () => {
    (useSession as jest.Mock).mockReturnValue({ data: { user: { isAdmin: false } } });
    renderAlert([UNMAPPED]);
    expect(screen.queryByRole("button", { name: /^map$/i })).not.toBeInTheDocument();
  });

  it("never offers Map without an integration", () => {
    renderAlert([UNMAPPED], { integrationId: undefined });
    expect(screen.queryByRole("button", { name: /^map$/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lines with no store product (hand-typed lines plan, C7)
// ---------------------------------------------------------------------------

describe("a line with no store product", () => {
  it.each([
    ['"0"', HAND_TYPED_ZERO],
    ['""', HAND_TYPED_EMPTY],
  ])("%s (admin): no Map button, the hint instead", (_label, line) => {
    renderAlert([line]);

    const group = screen.getByTestId("skipped-group-unmapped");
    expect(within(group).queryByRole("button", { name: /^map$/i })).not.toBeInTheDocument();
    expect(within(group).getByText(NO_STORE_PRODUCT_LINE_HINT)).toBeInTheDocument();
  });

  it("the hint is information, not an admin action: a non-admin sees it too", () => {
    (useSession as jest.Mock).mockReturnValue({ data: { user: { isAdmin: false } } });
    renderAlert([HAND_TYPED_ZERO]);

    expect(screen.getByText(NO_STORE_PRODUCT_LINE_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^map$/i })).not.toBeInTheDocument();
  });

  it("a catalog unmapped line (admin) keeps its Map button and gets no hint", () => {
    renderAlert([CATALOG_UNMAPPED]);

    expect(screen.getByRole("button", { name: /^map$/i })).toBeInTheDocument();
    expect(screen.queryByText(NO_STORE_PRODUCT_LINE_HINT)).not.toBeInTheDocument();
  });

  it("beside a catalog line, only the catalog line is offered Map", () => {
    renderAlert([CATALOG_UNMAPPED, HAND_TYPED_ZERO]);

    expect(screen.getAllByRole("button", { name: /^map$/i })).toHaveLength(1);
    expect(screen.getAllByText(NO_STORE_PRODUCT_LINE_HINT)).toHaveLength(1);
  });

  it.each([
    ["class-less (the heuristic)", UNAVAILABLE],
    ["stamped by the hook", UNAVAILABLE_STAMPED],
  ])("a mapped-but-unavailable line, %s, shows no hint", (_label, line) => {
    renderAlert([line]);

    expect(screen.getByTestId("skipped-group-unavailable")).toBeInTheDocument();
    expect(screen.queryByText(NO_STORE_PRODUCT_LINE_HINT)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^map$/i })).not.toBeInTheDocument();
  });
});
