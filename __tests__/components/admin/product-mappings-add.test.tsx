/** @jest-environment jsdom */
/**
 * `app/(app)/admin/product-mappings/page.tsx` + `BulkMapChooserDialog` +
 * `ProductMapDialog`'s title — § P2-B3-1R, M-b2 fix 4 (MS-3-16).
 *
 * On "All Integrations", Add Mapping used to target `integrations[0]` and the
 * map dialog never named the store, so an admin mapping what they took for an
 * Awake product could create the mapping in the OTHER store (the POST carries
 * the dialog's `integrationId`).
 *
 * Now, with the filter on `all` and more than one store, Add Mapping first asks
 * `Which store is this product from?` (the bulk chooser, reused), then opens the
 * map dialog for THAT store, titled `Map a product from {store}`. A filtered
 * store (or the only store) needs no question. The bulk path is unchanged.
 *
 * The real page, chooser and map dialog render; `fetch` is mocked.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

import AdminProductMappingsPage from "@/app/(app)/admin/product-mappings/page";

const integration = (id: string, name: string) => ({
  id,
  companyId: `co_${id}`,
  platform: "WOOCOMMERCE" as const,
  name,
  storeUrl: `https://${id}.example.test`,
  isActive: true,
  lastSyncAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  stockSyncEnabled: false,
  fulfillmentPushEnabled: false,
  lastStockSyncAt: null,
  lastStockSyncError: null,
  lastSyncError: null,
  syncLockedAt: null,
  lastWebhookReceivedAt: null,
  lastWebhookError: null,
  webhookFailureCount: 0,
  company: { name: name },
});

const STORE_A = integration("int_a", "Awake Store");
const STORE_B = integration("int_b", "Beta Store");

let integrationsList = [STORE_A, STORE_B];

function mockFetch() {
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

    if (init?.method === "POST" && /\/api\/products\/\d+\/links$/.test(href)) {
      return json({ id: "link_1" }, 201);
    }
    if (href.startsWith("/api/admin/integrations")) {
      return json({ integrations: integrationsList });
    }
    if (href.startsWith("/api/admin/product-mappings")) {
      return json({ mappings: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } });
    }
    if (/^\/api\/integrations\/[^/]+\/search-products\?/.test(href)) {
      return json({ products: [{ externalId: "ext_1", title: "Peptide X", sku: "PX-1" }] });
    }
    if (href.startsWith("/api/products?")) {
      return json({ products: [{ id: 42, name: "Peptide X 5mg", currentQuantity: 3 }] });
    }
    return json({});
  }) as unknown as typeof fetch;
}

const calls = () => (global.fetch as jest.Mock).mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
const mappingPosts = () =>
  calls()
    .filter(([url, init]) => init?.method === "POST" && /\/api\/products\/\d+\/links$/.test(String(url)))
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String(init!.body)) as Record<string, unknown>,
    }));
const storeSearches = () =>
  calls()
    .map(([url]) => String(url))
    .filter((u) => /\/search-products\?/.test(u));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  // The store list is already in the cache, as it is once the page has loaded.
  qc.setQueryData(["integrations"], integrationsList);
  return render(
    <QueryClientProvider client={qc}>
      <AdminProductMappingsPage />
    </QueryClientProvider>,
  );
}

const addMappingButton = () => screen.getAllByRole("button", { name: "Add Mapping" })[0];
const queryChooser = (name: string) => screen.queryByRole("dialog", { name });
const findMapDialog = (store: string) =>
  screen.findByRole("dialog", { name: `Map a product from ${store}` });

/** Drive the map dialog to a POST: pick the store product, then the internal one. */
async function mapAProduct(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByPlaceholderText("Search by product name or SKU..."), "Pep");
  await user.click(await within(dialog).findByRole("button", { name: /Peptide X/ }));
  await user.type(within(dialog).getByPlaceholderText("Search products..."), "Pep");
  await user.click(await within(dialog).findByRole("button", { name: "Map This" }));
  await waitFor(() => expect(mappingPosts()).toHaveLength(1));
  return mappingPosts()[0];
}

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  jest.clearAllMocks();
  integrationsList = [STORE_A, STORE_B];
  mockFetch();
});

describe("Add Mapping asks which store (MS-3-16)", () => {
  it('"all" + 2 stores → the chooser → the CHOSEN store\'s id is the one POSTed', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(addMappingButton());
    const chooser = await screen.findByRole("dialog", { name: "Which store is this product from?" });
    // Both stores are offered, each with its platform badge (never the raw enum).
    expect(within(chooser).getByRole("button", { name: /Awake Store/ })).toBeInTheDocument();
    expect(within(chooser).getAllByText("WOO")).toHaveLength(2);
    expect(within(chooser).queryByText("WOOCOMMERCE")).toBeNull();

    // Pick the SECOND store: today's code would have used integrations[0].
    await user.click(within(chooser).getByRole("button", { name: /Beta Store/ }));
    await waitFor(() => expect(queryChooser("Which store is this product from?")).toBeNull());

    const dialog = await findMapDialog("Beta Store");
    const sent = await mapAProduct(user, dialog);

    expect(sent.url).toBe("/api/products/42/links");
    expect(sent.body.integrationId).toBe("int_b");
    // The store catalog searched was the chosen store's.
    expect(storeSearches().length).toBeGreaterThan(0);
    expect(storeSearches().every((u) => u.startsWith("/api/integrations/int_b/"))).toBe(true);
    // The bulk-map page was never opened.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("dismissing the chooser opens no map dialog", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(addMappingButton());
    await screen.findByRole("dialog", { name: "Which store is this product from?" });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(queryChooser("Which store is this product from?")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("a filtered store → no chooser; the map dialog is that store's", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Beta Store" }));
    await user.click(addMappingButton());

    const dialog = await findMapDialog("Beta Store");
    expect(queryChooser("Which store is this product from?")).toBeNull();

    const sent = await mapAProduct(user, dialog);
    expect(sent.body.integrationId).toBe("int_b");
  });

  it('"all" with ONE store → no chooser; the map dialog names it', async () => {
    integrationsList = [STORE_A];
    const user = userEvent.setup();
    renderPage();

    await user.click(addMappingButton());

    expect(await findMapDialog("Awake Store")).toBeInTheDocument();
    expect(queryChooser("Which store is this product from?")).toBeNull();
  });
});

describe("the bulk path is unchanged", () => {
  it('Bulk Map on "all" + 2 stores → today\'s chooser text → the store\'s bulk-map page', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Bulk Map" }));
    const chooser = await screen.findByRole("dialog", { name: "Pick a store to bulk map" });
    expect(
      within(chooser).getByText("Choose which integration's catalog you want to map."),
    ).toBeInTheDocument();

    await user.click(within(chooser).getByRole("button", { name: /Beta Store/ }));

    expect(mockPush).toHaveBeenCalledWith("/admin/product-mappings/int_b/map");
    await waitFor(() => expect(queryChooser("Pick a store to bulk map")).toBeNull());
    // No map dialog opens on the bulk path.
    expect(screen.queryByRole("dialog", { name: /Map a product from/ })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /Map External Product/ })).toBeNull();
  });

  it("Bulk Map on a filtered store goes straight to that store's page", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Awake Store" }));
    await user.click(screen.getByRole("button", { name: "Bulk Map" }));

    expect(mockPush).toHaveBeenCalledWith("/admin/product-mappings/int_a/map");
    expect(queryChooser("Pick a store to bulk map")).toBeNull();
  });
});
