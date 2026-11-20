/** @jest-environment jsdom */
//
// Facelift F2 fix round FR2-1 (plan 2026-11-19-facelift-f2, REV 12; Q/A QA-1, a
// regression): the Products list never waits on locations without a client
// session. Driven through the REAL `LocationProvider` (every other list test
// mocks `@/contexts/location-context`).
//
// With no client session (next-auth turns a failed `/api/auth/session` into
// `null` / `"unauthenticated"` and stops re-checking) the provider reads
// nothing and its `isLoading` stays true. The provider is NOT changed (clearing
// `isLoading` with no user would reach its empty-list branch and delete the
// saved id); instead the list's products read is
// `enabled: !locationsLoading || sessionStatus === "unauthenticated"`:
//   - `"unauthenticated"`: the read goes out WITHOUT `hereLocationId` (the
//     server's `requireApproved` still guards it), the rows render, and there
//     is no endless skeleton;
//   - `"loading"`: the list still waits, so the first load never reads twice.

import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));
jest.mock("@/lib/export-utils", () => ({ exportToCSV: jest.fn() }));

import { LocationProvider, useLocation } from "@/contexts/location-context";
import { ProductListOptimized } from "@/components/products/product-list-optimized";

type Session = {
  data: { user: { id: string; defaultLocationId: number | null } } | null;
  status: "loading" | "authenticated" | "unauthenticated";
};
const NO_SESSION: Session = { data: null, status: "unauthenticated" };
const SESSION_LOADING: Session = { data: null, status: "loading" };
const SIGNED_IN: Session = { data: { user: { id: "u1", defaultLocationId: null } }, status: "authenticated" };
const setSession = (s: Session) => (useSession as jest.Mock).mockReturnValue(s);

const MAIN = { id: 1, name: "Main" };
const BACK = { id: 2, name: "Back" };
const rows = Array.from({ length: 3 }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  baseName: `Base ${i + 1}`,
  variant: null,
  approvalStatus: "APPROVED",
  currentQuantity: 0,
  totalQuantity: 50,
  lowStockThreshold: null,
  costPrice: null,
  retailPrice: null,
  stockState: "ok",
}));

/** The route's answer for one list read (the echoes as F2a built them). */
function serve(url: URL) {
  const here = url.searchParams.get("hereLocationId");
  return {
    products: rows.map((r) => ({ ...r, hereQuantity: here ? Number(here) * 10 + r.id : null })),
    total: rows.length,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    hereLocationId: here ? Number(here) : null,
    stock: url.searchParams.get("stock") ?? "all",
    search: url.searchParams.get("search") ?? "",
  };
}

let fetchMock: jest.Mock;
let ctx: ReturnType<typeof useLocation> | null = null;
function Probe() {
  ctx = useLocation();
  return null;
}

beforeEach(() => {
  ctx = null;
  setSession(SESSION_LOADING); // jest.setup's default
  window.localStorage.clear();
  Object.defineProperty(Element.prototype, "scrollTo", { value: jest.fn(), configurable: true, writable: true });
  fetchMock = jest.fn(async (input: unknown) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/locations") return { ok: true, json: async () => [MAIN, BACK] } as Response;
    if (url.pathname === "/api/products/optimized") return { ok: true, json: async () => serve(url) } as Response;
    throw new Error(`unexpected fetch ${url.pathname}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

const productCalls = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://x"))
    .filter((u) => u.pathname === "/api/products/optimized");
const locationCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/locations").length;
/** The List rows' main buttons. */
const mainButtons = () => screen.queryAllByRole("button", { name: /^Adjust stock for / });
const hereTexts = () => screen.queryAllByText(/ here$/);
const skeletons = (container: HTMLElement) => container.querySelectorAll('[class*="animate-pulse"]');

function tree(qc: QueryClient) {
  return (
    <LocationProvider>
      <QueryClientProvider client={qc}>
        <Probe />
        <div id="main">
          <ProductListOptimized onQuickAdjust={jest.fn()} onStockIn={jest.fn()} />
        </div>
      </QueryClientProvider>
    </LocationProvider>
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(tree(qc));
  return { ...utils, rerenderTree: () => utils.rerender(tree(qc)) };
}

/** A few rounds of effects and microtasks. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

describe("FR2-1 — the list never waits on locations without a client session (real LocationProvider)", () => {
  it("no client session (`unauthenticated`): the products read goes out WITHOUT `hereLocationId`, the rows render, no endless skeleton", async () => {
    window.localStorage.setItem("selectedLocationId", "2");
    setSession(NO_SESSION);
    const { container } = mount();

    expect(await screen.findByText("Showing 1–3 of 3 products")).toBeInTheDocument();
    expect(productCalls()).toHaveLength(1);
    expect(productCalls()[0].searchParams.has("hereLocationId")).toBe(false);
    expect(mainButtons()).toHaveLength(3);
    expect(screen.queryByRole("status")).toBeNull();
    expect(skeletons(container)).toHaveLength(0);
    expect(hereTexts()).toHaveLength(0);
    expect(screen.getByText(/Totals cover all locations\./)).toBeInTheDocument();

    // The provider is unchanged: with no user it reads nothing and still says
    // loading, and the saved id is kept (not deleted by an empty-list branch).
    expect(locationCalls()).toBe(0);
    expect(ctx?.isLoading).toBe(true);
    expect(ctx?.selectedLocationId).toBeNull();
    expect(window.localStorage.getItem("selectedLocationId")).toBe("2");

    await settle();
    expect(productCalls()).toHaveLength(1);
    expect(skeletons(container)).toHaveLength(0);
  });

  it("guard: while the session is `loading`, no products read yet (the skeleton waits)", async () => {
    window.localStorage.setItem("selectedLocationId", "2");
    setSession(SESSION_LOADING);
    const { container } = mount();
    await settle();

    expect(productCalls()).toHaveLength(0);
    expect(locationCalls()).toBe(0);
    expect(skeletons(container).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });

  it("`loading` -> signed in: ONE products read, already carrying the confirmed location (never two)", async () => {
    window.localStorage.setItem("selectedLocationId", "2");
    setSession(SESSION_LOADING);
    const { rerenderTree } = mount();
    await settle();
    expect(productCalls()).toHaveLength(0);

    setSession(SIGNED_IN);
    rerenderTree();
    expect(await screen.findByText("Showing 1–3 of 3 products")).toBeInTheDocument();
    await settle();
    expect(locationCalls()).toBe(1);
    expect(productCalls()).toHaveLength(1);
    expect(productCalls()[0].searchParams.get("hereLocationId")).toBe("2");
    expect(hereTexts().map((n) => n.textContent)).toEqual(["21 here", "22 here", "23 here"]);
  });

  it("`loading` -> `unauthenticated` (a failed session fetch): ONE read, without `hereLocationId`, and the rows", async () => {
    window.localStorage.setItem("selectedLocationId", "2");
    setSession(SESSION_LOADING);
    const { container, rerenderTree } = mount();
    await settle();
    expect(productCalls()).toHaveLength(0);

    setSession(NO_SESSION);
    rerenderTree();
    expect(await screen.findByText("Showing 1–3 of 3 products")).toBeInTheDocument();
    await settle();
    expect(productCalls()).toHaveLength(1);
    expect(productCalls()[0].searchParams.has("hereLocationId")).toBe(false);
    expect(mainButtons()).toHaveLength(3);
    expect(skeletons(container)).toHaveLength(0);
    expect(window.localStorage.getItem("selectedLocationId")).toBe("2");
  });
});
