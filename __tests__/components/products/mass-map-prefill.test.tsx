/** @jest-environment jsdom */
/**
 * THE MAP-PAGE PRE-FILL (pack C4b.2; spec REV-7 §4.4).
 *
 * The unmapped tab's deep link lands here carrying an external product, and the
 * map page has to put that row under the person's cursor. Three pins, and the
 * first one is why this test exists at all:
 *
 *   1. IT SCROLLS THROUGH THE VIRTUALIZER (OCk-2). `external-product-list.tsx`
 *      renders only `getVirtualItems()`, so on a real catalog the deep-linked
 *      row is usually NOT in the DOM — a `document.getElementById` scroll would
 *      pass every component test and do nothing in production. The list takes a
 *      `scrollToKey` and asks the virtualizer for the row's INDEX, so the pin
 *      is on `scrollToIndex`, not on a DOM node.
 *   2. A CATALOG THAT DOES NOT CARRY IT SAYS SO. The external product may have
 *      been deleted since the order was placed; the banner names that, rather
 *      than leaving the admin hunting a row nobody can find.
 *   3. IT WAITS FOR THE CATALOG. While the fetch is in flight there is no
 *      "not in the catalog" to claim, so nothing is claimed.
 *
 * `useCatalog` is mocked — dev egress is LOCKED, and the real hook talks to the
 * live store. The mock specifier is the `@/` path, which is how jest resolves
 * it from THIS file rather than relative to the component (OCk-18).
 */

import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CatalogResponse, CatalogRow } from "@/types/bulk-map";

const useCatalogMock = jest.fn();
const scrollToIndex = jest.fn();

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "x", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "x" }),
}));

jest.mock("@/components/products/mass-map/use-catalog", () => ({
  useCatalog: (...args: unknown[]) => useCatalogMock(...args),
}));

// The virtualizer cannot measure in jsdom (the sibling suites' stub), plus the
// one method this contract is about.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: (i: number) => number;
  }) => {
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
      scrollToIndex: (...args: unknown[]) => scrollToIndex(...args),
    };
  },
}));

import { MassMapClient } from "@/components/products/mass-map/mass-map-client";

/** VERBATIM (pack C4b.2). */
const NOT_IN_CATALOG =
  "This external product is not in the store catalog — it may have been deleted; nothing to map here.";

const ROWS: CatalogRow[] = [
  {
    externalProductId: "1",
    externalVariantId: "11",
    parentTitle: "Coffee Beans",
    variantTitle: "1 lb",
    sku: "CB1",
    type: "variation",
    attributes: [],
    alreadyMapped: false,
  },
  {
    externalProductId: "1",
    externalVariantId: "12",
    parentTitle: "Coffee Beans",
    variantTitle: "5 lb",
    sku: "CB5",
    type: "variation",
    attributes: [],
    alreadyMapped: false,
  },
  {
    externalProductId: "2",
    externalVariantId: null,
    parentTitle: "Mug",
    variantTitle: null,
    sku: "MUG",
    type: "simple",
    attributes: [],
    alreadyMapped: false,
  },
];

/**
 * The flattened item list the virtualizer indexes: a header per parent title,
 * then that parent's rows. Spelled out rather than computed, because the point
 * of the pin is that the index is the VIRTUAL one, not the row's position.
 *
 *   0 header "Coffee Beans" · 1 row 1::11 · 2 row 1::12 · 3 header "Mug" · 4 row 2::
 */
const MUG_VIRTUAL_INDEX = 4;

function catalog(rows: CatalogRow[] = ROWS): CatalogResponse {
  return {
    integration: { id: "i1", name: "Main", platform: "WOOCOMMERCE", storeUrl: "https://s" },
    rows,
    fetchedAt: "2026-08-24T10:00:00.000Z",
    warnings: [],
  };
}

function setCatalog(over: Record<string, unknown> = {}) {
  useCatalogMock.mockReturnValue({
    data: catalog(),
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: jest.fn(),
    ...over,
  });
}

function renderClient(prefill?: {
  externalProductId: string;
  externalVariantId: string | null;
  sku: string | null;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["bulk-map-internal-products"], []);
  return render(
    <QueryClientProvider client={client}>
      <MassMapClient integrationId="i1" prefill={prefill} />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  jest.clearAllMocks();
  setCatalog();
});

describe("a deep link the catalog carries", () => {
  it("selects the row, scrolls the VIRTUALIZER to it, and says where it came from", async () => {
    const { container } = renderClient({
      externalProductId: "2",
      externalVariantId: null,
      sku: "MUG",
    });

    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(MUG_VIRTUAL_INDEX, { align: "center" }),
    );

    const row = container.querySelector('[data-row-key="2::"]');
    expect(row).not.toBeNull();
    // The active row's own highlight, from the list's existing `active` rule.
    expect(row?.className).toContain("ring-primary/40");

    expect(screen.getByTestId("mass-map-prefill-chip")).toHaveTextContent(
      "pre-selected from the reconciliation page",
    );
    expect(screen.queryByTestId("mass-map-prefill-missing")).toBeNull();
  });

  it("lands on the UNMAPPED tab — a row somebody was sent here to map is unmapped", async () => {
    // The default tab is already `unmapped`, so this is a REGRESSION pin rather
    // than a liveness proof: a later default flip (or a prefill applied while
    // the admin sits on Mapped) must not leave the row on a hidden list.
    renderClient({ externalProductId: "2", externalVariantId: null, sku: "MUG" });

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    // `hidden: true`: selecting a row opens the mobile picker sheet (jsdom's
    // matchMedia answers false, so `useIsDesktop` is false), and Radix
    // aria-hides the page behind it.
    expect(screen.getByRole("tab", { name: /Unmapped/i, hidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  // OC-9: the deep link can land on a row that IS already mapped (the operator
  // fixed it between the report read and the click, or the exception is about the
  // mapping itself). Forcing the unmapped tab then selects a row on the list the
  // other tab is showing — an empty screen with an invisible selection.
  it("an alreadyMapped prefill lands on the MAPPED tab, with the row visible", async () => {
    useCatalogMock.mockReturnValue({
      data: catalog(
        ROWS.map((r) => (r.externalProductId === "2" ? { ...r, alreadyMapped: true } : r)),
      ),
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: jest.fn(),
    });

    const { container } = renderClient({
      externalProductId: "2",
      externalVariantId: null,
      sku: "MUG",
    });

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: /^Mapped/, hidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(container.querySelector('[data-row-key="2::"]')).not.toBeNull();
  });

  it("matches on the EXACT pair — a variant the link did not name is not the row", async () => {
    renderClient({ externalProductId: "1", externalVariantId: "12", sku: "CB5" });

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "center" }));
  });
});

describe("a deep link the catalog does not carry", () => {
  it("says the product is not in the catalog, VERBATIM, and scrolls nowhere", async () => {
    renderClient({ externalProductId: "999", externalVariantId: null, sku: "GONE" });

    expect(await screen.findByTestId("mass-map-prefill-missing")).toHaveTextContent(
      NOT_IN_CATALOG,
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mass-map-prefill-chip")).toBeNull();
  });

  it("claims NOTHING while the catalog is still loading", () => {
    setCatalog({ data: undefined, isLoading: true });
    renderClient({ externalProductId: "999", externalVariantId: null, sku: "GONE" });

    expect(screen.queryByTestId("mass-map-prefill-missing")).toBeNull();
    expect(screen.getByText("Loading catalog…")).toBeInTheDocument();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});

describe("no deep link at all", () => {
  it("neither selects, nor scrolls, nor claims anything is missing", async () => {
    const { container } = renderClient();

    await waitFor(() => expect(screen.getByRole("tab", { name: /Unmapped/i })).toBeInTheDocument());
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mass-map-prefill-missing")).toBeNull();
    expect(screen.queryByTestId("mass-map-prefill-chip")).toBeNull();
    expect(container.querySelector('[data-row-key="2::"]')?.className).not.toContain(
      "ring-primary/40",
    );
  });
});

// § P2-B3-1R, M-b3 fix 3 (G1-3): the deep link used to set the active row
// directly, skipping the click handler that fetched an existing bundle's
// components, so a deep-linked bundle opened an EMPTY editor (and confirming it
// replaced the real components). It now goes through the one `selectRow`.
describe("a deep link to an existing bundle (MS-2-1)", () => {
  const BUNDLE_ROW: CatalogRow = {
    externalProductId: "40",
    externalVariantId: null,
    parentTitle: "Gift Box",
    variantTitle: null,
    sku: "GB",
    type: "simple",
    attributes: [],
    alreadyMapped: true,
    existingMapping: {
      linkId: "LBX",
      internalProductId: null,
      internalProductName: "",
      isBundle: true,
      componentCount: 2,
    },
  };

  let resolveMappings: ((a: unknown) => void) | null = null;

  beforeEach(() => {
    resolveMappings = null;
    global.fetch = jest.fn((url: string | URL | Request) => {
      if (String(url).startsWith("/api/admin/product-mappings")) {
        return new Promise((resolve) => {
          resolveMappings = resolve;
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }) as unknown as typeof fetch;
    useCatalogMock.mockReturnValue({
      data: catalog([...ROWS, BUNDLE_ROW]),
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it("loads the bundle's REAL components into the editor; nothing editable before they answer", async () => {
    renderClient({ externalProductId: "40", externalVariantId: null, sku: "GB" });

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/product-mappings?integrationId=i1&pageSize=500",
      ),
    );
    // The phone sheet hides the page behind it, so the queries reach into it.
    expect(
      screen.queryByRole("button", { name: "Confirm bundle mapping", hidden: true }),
    ).toBeNull();

    await act(async () => {
      resolveMappings?.({
        ok: true,
        status: 200,
        json: async () => ({
          mappings: [
            {
              id: "LBX",
              bundleComponents: [
                { internalProductId: 1, quantity: 2, sortOrder: 0, internalProduct: { name: "Widget 1" } },
                { internalProductId: 2, quantity: 1, sortOrder: 1, internalProduct: { name: "Widget 2" } },
              ],
            },
          ],
        }),
      });
    });

    expect(
      screen.getByRole("button", { name: "Confirm bundle mapping", hidden: true }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: /^Remove /, hidden: true })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Remove Widget 1", "Remove Widget 2"]);
  });
});

describe("the page hands the client exactly the three deep-link params (S13)", () => {
  it("reads externalProductId / externalVariantId / sku off searchParams", () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "../../../app/(app)/admin/product-mappings/[integrationId]/map/page.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("searchParams");
    expect(source).toContain("externalProductId");
    expect(source).toContain("externalVariantId");
    expect(source).toContain("sku");
    expect(source).toContain("prefill");
  });
});
