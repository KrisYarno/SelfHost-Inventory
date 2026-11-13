/** @jest-environment jsdom */
/**
 * `components/products/mass-map/bundle-builder.tsx` — § P2-B3-1R, M-b3 fix 3
 * (MS-2-1).
 *
 * The builder seeds its component list ONCE, at mount (`useState(initial…)`),
 * and confirming sends that list as the bundle's WHOLE new set. That is only
 * safe because the host now mounts it after the row's real components are known
 * and keys it by the row. These pins hold the builder's half of that contract:
 *   - it shows exactly the components it was mounted with;
 *   - a later change to `initialComponents` does NOT reach the list (which is why
 *     the host must key it — the picker suite pins the keying);
 *   - a new key is a fresh mount with the new row's components;
 *   - confirming sends the seeded list, with any edits.
 */

import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BundleBuilder,
  type BundleBuilderComponent,
} from "@/components/products/mass-map/bundle-builder";
import type { CatalogRow } from "@/types/bulk-map";

const rowA: CatalogRow = {
  externalProductId: "10",
  externalVariantId: null,
  parentTitle: "Gift Box A",
  variantTitle: null,
  sku: "GBA",
  type: "simple",
  attributes: [],
  alreadyMapped: true,
  existingMapping: {
    linkId: "LA",
    internalProductId: null,
    internalProductName: "",
    isBundle: true,
    componentCount: 2,
  },
};

const rowB: CatalogRow = {
  ...rowA,
  externalProductId: "20",
  parentTitle: "Gift Box B",
  sku: "GBB",
  existingMapping: { ...rowA.existingMapping!, linkId: "LB", componentCount: 1 },
};

const A_COMPONENTS: BundleBuilderComponent[] = [
  { internalProductId: 1, internalProductName: "Widget A1", quantity: 2, sortOrder: 0 },
  { internalProductId: 2, internalProductName: "Widget A2", quantity: 1, sortOrder: 1 },
];
const B_COMPONENTS: BundleBuilderComponent[] = [
  { internalProductId: 3, internalProductName: "Widget B1", quantity: 4, sortOrder: 0 },
];

function Builder({
  row,
  components,
  builderKey,
  onConfirm = jest.fn(),
}: {
  row: CatalogRow;
  components: BundleBuilderComponent[];
  builderKey?: string;
  onConfirm?: (c: BundleBuilderComponent[]) => void;
}) {
  return (
    <BundleBuilder
      key={builderKey}
      row={row}
      index={[]}
      initialComponents={components}
      saving={false}
      errorMessage={null}
      onConfirm={onConfirm}
      onCancel={jest.fn()}
      onConvertToSingle={jest.fn()}
    />
  );
}

function wrap(node: React.ReactNode, client: QueryClient) {
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The component names the builder is showing, in order. */
function shownComponents(): string[] {
  return screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((b) => (b.getAttribute("aria-label") ?? "").replace(/^Remove /, ""));
}

describe("BundleBuilder seeds at mount (MS-2-1)", () => {
  it("shows exactly the components it was mounted with", () => {
    render(wrap(<Builder row={rowA} components={A_COMPONENTS} />, newClient()));
    expect(shownComponents()).toEqual(["Widget A1", "Widget A2"]);
    expect(screen.getByText("Components (2)")).toBeInTheDocument();
  });

  it("an empty seed (a new bundle) starts empty and cannot be confirmed", () => {
    render(wrap(<Builder row={rowA} components={[]} />, newClient()));
    expect(shownComponents()).toEqual([]);
    expect(screen.getByText(/No components yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm bundle mapping" })).toBeDisabled();
  });

  it("a later initialComponents change does NOT reach a mounted builder (why the host keys it)", () => {
    const client = newClient();
    const { rerender } = render(wrap(<Builder row={rowA} components={[]} />, client));
    rerender(wrap(<Builder row={rowA} components={A_COMPONENTS} />, client));
    expect(shownComponents()).toEqual([]);
  });

  it("a new key is a fresh mount with the new row's components", () => {
    const client = newClient();
    const { rerender } = render(
      wrap(<Builder builderKey="10::" row={rowA} components={A_COMPONENTS} />, client),
    );
    expect(shownComponents()).toEqual(["Widget A1", "Widget A2"]);

    rerender(wrap(<Builder builderKey="20::" row={rowB} components={B_COMPONENTS} />, client));
    expect(shownComponents()).toEqual(["Widget B1"]);
    expect(screen.getAllByText("Gift Box B").length).toBeGreaterThan(0);
  });

  it("confirming sends the seeded list, with the operator's edits", async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    render(wrap(<Builder row={rowA} components={A_COMPONENTS} onConfirm={onConfirm} />, newClient()));

    await user.click(screen.getByRole("button", { name: "Remove Widget A2" }));
    const row = screen.getByText("Widget A1").closest("div") as HTMLElement;
    fireEvent.change(within(row).getByRole("spinbutton"), { target: { value: "3" } });

    await user.click(screen.getByRole("button", { name: "Confirm bundle mapping" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toEqual([
      { internalProductId: 1, internalProductName: "Widget A1", quantity: 3, sortOrder: 0 },
    ]);
  });
});
