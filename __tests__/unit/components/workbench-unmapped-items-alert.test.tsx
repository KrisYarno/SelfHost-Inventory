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
