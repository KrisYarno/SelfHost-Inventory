/** @jest-environment jsdom */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "x", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "x" }),
}));

// Virtualizer can't measure in jsdom; render every item.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => {
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
    };
  },
}));

// jsdom's matchMedia answers false (phone); the bundle-seed arms below pick the
// desktop panel or the phone sheet explicitly. Default = jsdom's answer.
const isDesktopMock = jest.fn(() => false);
jest.mock("@/components/products/mass-map/use-viewport", () => ({
  useIsDesktop: () => isDesktopMock(),
}));

import { MassMapClient } from "@/components/products/mass-map/mass-map-client";
import type { CatalogResponse, CatalogRow } from "@/types/bulk-map";

function seed(client: QueryClient) {
  const data: CatalogResponse = {
    integration: { id: "i1", name: "Main", platform: "WOOCOMMERCE", storeUrl: "https://s" },
    rows: [
      { externalProductId: "1", externalVariantId: null, parentTitle: "Mug", variantTitle: null, sku: "MUG", type: "simple", attributes: [], alreadyMapped: false },
      { externalProductId: "2", externalVariantId: null, parentTitle: "Hat", variantTitle: null, sku: "HAT", type: "simple", attributes: [], alreadyMapped: true, existingMapping: { linkId: "L", internalProductId: 7, internalProductName: "Hat Internal", isBundle: false, componentCount: null } },
    ],
    fetchedAt: new Date().toISOString(),
    warnings: [],
  };
  client.setQueryData(["bulk-map-catalog", "i1"], data);
  client.setQueryData(["bulk-map-internal-products"], []);
}

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return (
    <QueryClientProvider client={client}>
      <MassMapClient integrationId="i1" />
    </QueryClientProvider>
  );
}

describe("MassMapClient", () => {
  it("renders unmapped count and mapped count on the tabs", () => {
    render(harness());
    expect(screen.getByRole("tab", { name: /Unmapped/i })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /^Mapped/i })).toHaveTextContent("1");
  });

  it("switches to the Mapped tab and shows the mapped row", async () => {
    const user = userEvent.setup();
    render(harness());
    await user.click(screen.getByRole("tab", { name: /^Mapped/i }));
    // "Hat" appears twice — once as header, once as the simple-product row title
    expect(screen.getAllByText("Hat").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the warnings banner when warnings are present", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData<CatalogResponse>(["bulk-map-catalog", "i1"], {
      integration: { id: "i1", name: "Main", platform: "WOOCOMMERCE", storeUrl: "https://s" },
      rows: [],
      fetchedAt: new Date().toISOString(),
      warnings: [
        { kind: "variations-failed", productId: "10", parentTitle: "Coffee Beans", message: "boom" },
      ],
    });
    client.setQueryData(["bulk-map-internal-products"], []);
    render(
      <QueryClientProvider client={client}>
        <MassMapClient integrationId="i1" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Partial catalog/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// § P2-B3-1R, M-b3 fix 3 (MS-2-1): editing a bundle loads its REAL components.
//
// The editor used to mount the moment a row was picked, seeded with whatever
// `initialBundleComponents` held — nothing yet, or the PREVIOUS bundle's — and
// the fetch's answer arrived after the one-time seed had been read. A failed
// fetch seeded `[]`. Confirming then replaced the bundle's real components
// wholesale. Now ONE `selectRow` seeds `{ key, status, components }`:
//   - a new bundle candidate -> ready, [] at once (no fetch);
//   - an existing bundle -> loading until ITS answer; a late answer for another
//     selection is ignored;
//   - an error / non-OK / link missing -> failed: the sentence + Retry, no editor;
//   - every close path clears it.
// ---------------------------------------------------------------------------

const BUNDLE_ROWS: CatalogRow[] = [
  {
    externalProductId: "10",
    externalVariantId: null,
    parentTitle: "Gift Box A",
    variantTitle: null,
    sku: "GBA",
    type: "simple",
    attributes: [],
    alreadyMapped: true,
    existingMapping: { linkId: "LA", internalProductId: null, internalProductName: "", isBundle: true, componentCount: 2 },
  },
  {
    externalProductId: "20",
    externalVariantId: null,
    parentTitle: "Gift Box B",
    variantTitle: null,
    sku: "GBB",
    type: "simple",
    attributes: [],
    alreadyMapped: true,
    existingMapping: { linkId: "LB", internalProductId: null, internalProductName: "", isBundle: true, componentCount: 1 },
  },
  {
    externalProductId: "30",
    externalVariantId: null,
    parentTitle: "Sampler C",
    variantTitle: null,
    sku: "SC",
    type: "simple",
    attributes: [],
    alreadyMapped: false,
    isBundleCandidate: true,
  },
];

const MAPPINGS = {
  LA: {
    id: "LA",
    bundleComponents: [
      { internalProductId: 1, quantity: 2, sortOrder: 0, internalProduct: { name: "Widget A1" } },
      { internalProductId: 2, quantity: 1, sortOrder: 1, internalProduct: { name: "Widget A2" } },
    ],
  },
  LB: {
    id: "LB",
    bundleComponents: [{ internalProductId: 3, quantity: 4, sortOrder: 0, internalProduct: { name: "Widget B1" } }],
  },
};

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
/** Every product-mappings request, answered by hand, in call order. */
let mappingCalls: Array<{ url: string; resolve: (a: Answer) => void; reject: (e: unknown) => void }> = [];

function bundleHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<CatalogResponse>(["bulk-map-catalog", "i1"], {
    integration: { id: "i1", name: "Main", platform: "WOOCOMMERCE", storeUrl: "https://s" },
    rows: BUNDLE_ROWS,
    fetchedAt: new Date().toISOString(),
    warnings: [],
  });
  client.setQueryData(["bulk-map-internal-products"], []);
  return render(
    <QueryClientProvider client={client}>
      <MassMapClient integrationId="i1" />
    </QueryClientProvider>,
  );
}

const ok = (mappings: unknown[]): Answer => ({ ok: true, status: 200, json: async () => ({ mappings }) });

async function answer(i: number, a: Answer) {
  await act(async () => {
    mappingCalls[i].resolve(a);
  });
}

function rowButton(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector(`[data-row-key="${key}"]`);
  if (!el) throw new Error(`row ${key} not rendered`);
  return el as HTMLElement;
}

const editorShown = () =>
  screen.queryByRole("button", { name: "Confirm bundle mapping", hidden: true });
const componentNames = () =>
  screen
    .queryAllByRole("button", { name: /^Remove /, hidden: true })
    .map((b) => (b.getAttribute("aria-label") ?? "").replace(/^Remove /, ""));
const FAILED = "Couldn't load this bundle's components.";

describe("MassMapClient — the bundle editor's seed (MS-2-1)", () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
    Element.prototype.setPointerCapture = jest.fn() as never;
    Element.prototype.releasePointerCapture = jest.fn() as never;
    Element.prototype.scrollIntoView = jest.fn() as never;
  });

  beforeEach(() => {
    isDesktopMock.mockReturnValue(true);
    mappingCalls = [];
    global.fetch = jest.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith("/api/admin/product-mappings")) {
        return new Promise<Answer>((resolve, reject) => {
          mappingCalls.push({ url: u, resolve, reject });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    isDesktopMock.mockReturnValue(false);
  });

  async function openMappedTab() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /^Mapped/i }));
    return user;
  }

  it("an existing bundle: no editor while loading, then ITS real components", async () => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    expect(mappingCalls).toHaveLength(1);
    expect(mappingCalls[0].url).toBe("/api/admin/product-mappings?integrationId=i1&pageSize=500");
    expect(editorShown()).toBeNull();
    expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();

    await answer(0, ok([MAPPINGS.LA, MAPPINGS.LB]));
    expect(editorShown()).not.toBeNull();
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
  });

  it("A -> B shows B's components, not A's", async () => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await answer(0, ok([MAPPINGS.LA, MAPPINGS.LB]));
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);

    await user.click(rowButton(container, "20::"));
    expect(editorShown()).toBeNull();
    await answer(1, ok([MAPPINGS.LA, MAPPINGS.LB]));
    expect(componentNames()).toEqual(["Widget B1"]);
  });

  it("a late A answer is ignored: B stays loading, then shows B's", async () => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await user.click(rowButton(container, "20::"));

    await answer(0, ok([MAPPINGS.LA, MAPPINGS.LB]));
    expect(editorShown()).toBeNull();
    expect(componentNames()).toEqual([]);

    await answer(1, ok([MAPPINGS.LA, MAPPINGS.LB]));
    expect(componentNames()).toEqual(["Widget B1"]);
  });

  it("a late answer from an EARLIER visit to the same row is ignored (A -> B -> A)", async () => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await user.click(rowButton(container, "20::"));
    await user.click(rowButton(container, "10::"));

    // The first A request answers with a stale set; only the third request counts.
    await answer(0, ok([{ ...MAPPINGS.LA, bundleComponents: [MAPPINGS.LB.bundleComponents[0]] }]));
    expect(editorShown()).toBeNull();

    await answer(2, ok([MAPPINGS.LA]));
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
  });

  it.each([
    ["a non-OK answer", (i: number) => answer(i, { ok: false, status: 500, json: async () => ({ error: "boom" }) })],
    [
      "a network error",
      async (i: number) => {
        await act(async () => {
          mappingCalls[i].reject(new Error("offline"));
        });
      },
    ],
    ["the link missing from the answer", (i: number) => answer(i, ok([MAPPINGS.LB]))],
  ])("%s -> the failed sentence + Retry, and NO editor", async (_label, fail) => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await fail(0);

    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(editorShown()).toBeNull();
  });

  // FR-R1 (11), CR-G1-5: the failed view's way out on desktop.
  it("Cancel from the failed view: no selection, no editor; a reopen loads afresh", async () => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await answer(0, { ok: false, status: 500, json: async () => ({}) });
    expect(screen.getByText(FAILED)).toBeInTheDocument();
    // The row is the active selection (the list's ring).
    expect(rowButton(container, "10::")).toHaveClass("ring-primary/40");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(editorShown()).toBeNull();
    expect(screen.getByText(/Pick a row from the list to map it/)).toBeInTheDocument();
    expect(rowButton(container, "10::")).not.toHaveClass("ring-primary/40");

    await user.click(rowButton(container, "10::"));
    expect(mappingCalls).toHaveLength(2);
    expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();
  });

  it("Retry recovers: a fresh fetch, then the real components", async () => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await answer(0, { ok: false, status: 500, json: async () => ({}) });
    expect(screen.getByText(FAILED)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mappingCalls).toHaveLength(2);
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(editorShown()).toBeNull();

    await answer(1, ok([MAPPINGS.LA]));
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
  });

  it("a new bundle candidate mounts the editor at once, empty, with no fetch", async () => {
    const { container } = bundleHarness();
    const user = userEvent.setup();

    await user.click(rowButton(container, "30::"));
    expect(editorShown()).not.toBeNull();
    expect(componentNames()).toEqual([]);
    expect(mappingCalls).toHaveLength(0);
  });

  it("the editor's Cancel clears the seed: a reopen loads afresh", async () => {
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await answer(0, ok([MAPPINGS.LA]));
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editorShown()).toBeNull();
    expect(screen.getByText(/Pick a row from the list to map it/)).toBeInTheDocument();

    await user.click(rowButton(container, "10::"));
    expect(editorShown()).toBeNull();
    expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();
    await answer(1, ok([MAPPINGS.LA]));
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
  });

  it("the phone sheet's close clears the seed too", async () => {
    isDesktopMock.mockReturnValue(false);
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    await answer(0, ok([MAPPINGS.LA]));
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(editorShown()).toBeNull());

    await user.click(rowButton(container, "20::"));
    expect(editorShown()).toBeNull();
    await answer(1, ok([MAPPINGS.LB]));
    expect(componentNames()).toEqual(["Widget B1"]);
  });

  it("an answer still in flight when the sheet closes lands nowhere; a reopen loads afresh", async () => {
    isDesktopMock.mockReturnValue(false);
    const { container } = bundleHarness();
    const user = await openMappedTab();

    await user.click(rowButton(container, "10::"));
    expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("bundle-seed-loading")).toBeNull());

    await answer(0, ok([MAPPINGS.LA]));
    expect(editorShown()).toBeNull();

    await user.click(rowButton(container, "10::"));
    expect(editorShown()).toBeNull();
    expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();
    await answer(1, ok([MAPPINGS.LA]));
    expect(componentNames()).toEqual(["Widget A1", "Widget A2"]);
  });

  it.each([["Finished mapping"], ["Keep mapping →"]])(
    "%s after a confirmed bundle clears the seed: the next open of that row loads afresh",
    async (closeLabel) => {
      const { container } = bundleHarness();
      const user = await openMappedTab();

      await user.click(rowButton(container, "10::"));
      await answer(0, ok([MAPPINGS.LA]));
      await user.click(screen.getByRole("button", { name: "Confirm bundle mapping" }));
      // `editBundle` (use-row-actions) PATCHes through the mocked fetch and
      // succeeds. Unedited, it sends the bundle's REAL components back.
      expect(await screen.findByText(/Mapped successfully/i)).toBeInTheDocument();
      const patch = (global.fetch as jest.Mock).mock.calls.find(
        ([url]) => String(url) === "/api/products/bundle-links/LA",
      );
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        components: [
          { internalProductId: 1, quantity: 2 },
          { internalProductId: 2, quantity: 1 },
        ],
      });

      await user.click(screen.getByRole("button", { name: closeLabel }));
      await waitFor(() => expect(screen.queryByText(/Mapped successfully/i)).toBeNull());
      expect(screen.getByText(/Pick a row from the list to map it/)).toBeInTheDocument();

      await user.click(rowButton(container, "10::"));
      expect(editorShown()).toBeNull();
      expect(screen.getByTestId("bundle-seed-loading")).toBeInTheDocument();
    },
  );
});
