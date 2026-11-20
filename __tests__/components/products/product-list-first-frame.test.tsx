/** @jest-environment jsdom */
//
// Facelift F2 FR1-12 (plan 2026-11-19-facelift-f2, REV 7) — A REMEMBERED GRID
// IS THE FIRST FRAME. The saved view is read in an isomorphic LAYOUT effect,
// so its update is rendered and committed inside the same task as the first
// commit, before the browser can paint. Read in a passive effect (as before),
// the List was committed, the browser could paint it, and only a later task
// swapped in the Grid: a Grid user saw the List flash on every visit.
//
// jsdom cannot paint, so the paint boundary is made visible: outside `act`,
// React works through Scheduler's tasks, one host macrotask at a time
// (`setTimeout` in this environment), and a browser may paint between any two
// of them. A stepped `performance.now` makes Scheduler yield after every task,
// so the test's own macrotask runs right after the task that holds the first
// commit — where the first paint would be. Whatever the DOM holds then is the
// first painted frame.

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({
    selectedLocation: { id: 1, name: "Main" },
    selectedLocationId: 1,
    isLoading: false,
    loadFailed: false,
  }),
}));

import { ProductListOptimized } from "@/components/products/product-list-optimized";

const rowFrame = (el: ParentNode) => el.querySelector(".lg\\:hidden.rounded-lg.border.bg-surface.divide-y");
const tileGrid = (el: ParentNode) =>
  el.querySelector(".grid.grid-cols-2.gap-2.sm\\:grid-cols-3.lg\\:grid-cols-4.xl\\:grid-cols-5");
/** One host macrotask: Scheduler's pending one runs first (FIFO), then this resolves. */
const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actEnv: boolean | undefined;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Outside act: React schedules its work on Scheduler, as in a browser.
  actEnv = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  window.localStorage.clear();
  // The products read never answers: the frame under test is the skeleton's.
  global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  jest.restoreAllMocks();
  root.unmount();
  for (let i = 0; i < 5; i++) await nextMacrotask();
  host.remove();
  g.IS_REACT_ACT_ENVIRONMENT = actEnv;
});

/** Renders, lets exactly the FIRST Scheduler task run, and returns at the first paint boundary. */
async function renderUntilFirstPaint() {
  // Each clock read moves 3 ms: the first task always starts (3 ms < Scheduler's
  // 5 ms slice), and every later check is past the slice, so Scheduler yields
  // to the host after every task.
  let clock = 0;
  jest.spyOn(performance, "now").mockImplementation(() => (clock += 3));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <QueryClientProvider client={qc}>
      <div id="main">
        <ProductListOptimized onQuickAdjust={jest.fn()} onStockIn={jest.fn()} />
      </div>
    </QueryClientProvider>
  );
  expect(host.childElementCount).toBe(0); // nothing is rendered until Scheduler's task runs
  await nextMacrotask();
  expect(host.childElementCount).toBeGreaterThan(0); // the first commit is in
}

describe("FR1-12 — the saved view is in the first painted frame", () => {
  it("a remembered Grid: at the first paint boundary the DOM is already the Grid (never the List)", async () => {
    window.localStorage.setItem("products.view", "grid");
    await renderUntilFirstPaint();
    expect(tileGrid(host)).not.toBeNull();
    expect(rowFrame(host)).toBeNull();
  });

  it("nothing remembered: the first paint is the List (the default)", async () => {
    await renderUntilFirstPaint();
    expect(rowFrame(host)).not.toBeNull();
    expect(tileGrid(host)).toBeNull();
  });

  it("storage that throws: the first paint is the List, and nothing breaks", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await renderUntilFirstPaint();
    expect(rowFrame(host)).not.toBeNull();
  });
});
