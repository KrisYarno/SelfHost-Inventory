/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  InternalProductPicker,
  type BundleSeed,
} from "@/components/products/mass-map/internal-product-picker";
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

// ---------------------------------------------------------------------------
// § P2-B3-1R, M-b3 fix 3 (MS-2-1): the bundle editor mounts only on a READY
// seed for THIS row, keyed by the row. It used to mount at once, seeded with
// whatever `initialBundleComponents` held (nothing yet, or the previous row's),
// and confirming replaced the bundle's real components with that list.
// ---------------------------------------------------------------------------

const bundleRowA: CatalogRow = {
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
const bundleRowB: CatalogRow = {
  ...bundleRowA,
  externalProductId: "20",
  parentTitle: "Gift Box B",
  sku: "GBB",
  existingMapping: { ...bundleRowA.existingMapping!, linkId: "LB", componentCount: 1 },
};

const seedA = (status: BundleSeed["status"]): BundleSeed => ({
  key: "10::",
  status,
  components:
    status === "ready"
      ? [
          { internalProductId: 1, internalProductName: "Widget A1", quantity: 2, sortOrder: 0 },
          { internalProductId: 2, internalProductName: "Widget A2", quantity: 1, sortOrder: 1 },
        ]
      : [],
});
const seedB: BundleSeed = {
  key: "20::",
  status: "ready",
  components: [{ internalProductId: 3, internalProductName: "Widget B1", quantity: 4, sortOrder: 0 }],
};

function BundlePicker({
  row,
  seed,
  onRetry = jest.fn(),
  onCancel = jest.fn(),
}: {
  row: CatalogRow;
  seed: BundleSeed | null;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  return (
    <InternalProductPicker
      row={row}
      index={index}
      indexLoading={false}
      saving={false}
      errorMessage={null}
      successFor={null}
      onConfirm={jest.fn()}
      onCancel={onCancel}
      onFinishSuccess={jest.fn()}
      onKeepSuccess={jest.fn()}
      bundleMode
      bundleSeed={seed}
      onRetryBundleSeed={onRetry}
      onConfirmBundle={jest.fn()}
    />
  );
}

const editorShown = () => screen.queryByRole("button", { name: "Confirm bundle mapping" });
const componentNames = () =>
  screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((b) => (b.getAttribute("aria-label") ?? "").replace(/^Remove /, ""));

describe("InternalProductPicker — the bundle seed (MS-2-1)", () => {
  it("loading: a loading line and NO editor", () => {
    render(<BundlePicker row={bundleRowA} seed={seedA("loading")} />, { wrapper });
    expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();
    expect(editorShown()).toBeNull();
  });

  it("failed: the verbatim sentence + Retry, and NO editor", async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();
    render(<BundlePicker row={bundleRowA} seed={seedA("failed")} onRetry={onRetry} />, { wrapper });
    expect(screen.getByText("Couldn't load this bundle's components.")).toBeInTheDocument();
    expect(editorShown()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // FR-R1 (11), CR-G1-5: on desktop the picker is an inline panel with no
  // close of its own, so the failed view had no way out but Retry.
  it("failed: `Cancel` is the way out — it closes the selection (the host's onCancel)", async () => {
    const user = userEvent.setup();
    const onCancel = jest.fn();
    const onRetry = jest.fn();
    render(<BundlePicker row={bundleRowA} seed={seedA("failed")} onCancel={onCancel} onRetry={onRetry} />, {
      wrapper,
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("ready: the editor, seeded with THIS row's components", () => {
    render(<BundlePicker row={bundleRowA} seed={seedA("ready")} />, { wrapper });
    expect(editorShown()).not.toBeNull();
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
  });

  it("a ready seed for ANOTHER row is not this row's: no editor", () => {
    render(<BundlePicker row={bundleRowB} seed={seedA("ready")} />, { wrapper });
    expect(editorShown()).toBeNull();
    expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();
  });

  it("no seed at all: no editor", () => {
    render(<BundlePicker row={bundleRowA} seed={null} />, { wrapper });
    expect(editorShown()).toBeNull();
  });

  it("keyed by row: A's editor, then B's seed, shows B's components (a fresh mount)", () => {
    const { rerender } = render(<BundlePicker row={bundleRowA} seed={seedA("ready")} />, { wrapper });
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
    rerender(<BundlePicker row={bundleRowB} seed={seedB} />);
    expect(componentNames()).toEqual(["Widget B1"]);
  });

  it("loading then ready for the same row: the editor mounts with the answered components", () => {
    const { rerender } = render(<BundlePicker row={bundleRowA} seed={seedA("loading")} />, { wrapper });
    expect(editorShown()).toBeNull();
    rerender(<BundlePicker row={bundleRowA} seed={seedA("ready")} />);
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
  });
});
