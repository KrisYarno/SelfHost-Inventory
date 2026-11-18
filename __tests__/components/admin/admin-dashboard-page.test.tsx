/** @jest-environment jsdom */
//
// Facelift F0-4 (plan 2026-11-17-facelift-f0, F0-4 + the REV 2 folds) — the
// admin overview's lists are never "empty" while loading or after a failure.
//
// Before: `metrics?.topMovingProducts?.slice().map() || <p>No …</p>` showed the
// empty copy while loading and after a failed read, and NOTHING for a loaded
// empty array (an empty array is truthy). A failed read with no data also
// filled the metric strip with zeros. Now: a skeleton while loading,
// `Couldn't load …` + Retry when the read failed with nothing loaded, the
// period-named empty copy on a loaded `[]`, and `--` in the strip on a failed
// read. The hook polls every 30 s, so a failed POLL over loaded data keeps the
// data and shows no error copy.

import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockLink = React.forwardRef<HTMLAnchorElement, any>(({ children, href, ...r }, ref) => (
    <a ref={ref} href={typeof href === "string" ? href : "#"} {...r}>
      {children}
    </a>
  ));
  MockLink.displayName = "NextLinkMock";
  return { __esModule: true, default: MockLink };
});
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock("@/components/admin/ops-health-section", () => ({ OpsHealthSection: () => null }));
jest.mock("@/components/admin/rate-limit-monitor", () => ({ RateLimitMonitor: () => null }));

import AdminDashboardPage from "@/app/(app)/admin/page";

const LOADED = {
  totalProducts: 120,
  totalUsers: 4,
  activeUsers: 3,
  pendingUsers: 1,
  lowStockProducts: 6,
  outOfStockProducts: 2,
  recentTransactions: 17,
  topMovingProducts: [{ id: 9, name: "Widget", movement: 42 }],
  recentActivity: [
    {
      id: 5,
      user: "kris",
      action: "Added to",
      product: "Widget",
      quantity: 4,
      timestamp: new Date("2026-11-17T12:00:00Z").toISOString(),
    },
  ],
};

type Reply = "pending" | "error" | { ok: true; body: typeof LOADED };

let fetchMock: jest.Mock;
let reply: Reply;
function mockFetch(next: Reply) {
  reply = next;
  fetchMock = jest.fn(() => {
    if (reply === "pending") return new Promise<Response>(() => {});
    if (reply === "error") {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response);
    }
    const body = reply.body;
    return Promise.resolve({ ok: true, json: async () => body } as Response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

let qc: QueryClient;
function renderPage() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminDashboardPage />
    </QueryClientProvider>,
  );
}

const card = (title: string) => screen.getByText(title).closest(".rounded-2xl") as HTMLElement;

describe("F0-4 — admin top movers and recent activity", () => {
  it("while loading: skeletons, never an empty sentence", () => {
    mockFetch("pending");
    renderPage();

    for (const title of ["Top Moving Products", "Recent Activity"]) {
      const c = card(title);
      expect(c.querySelector(".animate-pulse")).not.toBeNull();
      expect(c).not.toHaveTextContent(/No /);
    }
  });

  it("a failed read with no data: each list says so with Retry; the strip shows `--`, never 0", async () => {
    mockFetch("error");
    renderPage();

    const movers = card("Top Moving Products");
    expect(await within(movers).findByText("Couldn't load product movement.")).toBeInTheDocument();
    const activity = card("Recent Activity");
    expect(within(activity).getByText("Couldn't load recent activity.")).toBeInTheDocument();

    expect(screen.getAllByText("--")).toHaveLength(4);
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText(/pending approval|out of stock/)).toBeNull();

    const before = fetchMock.mock.calls.length;
    fireEvent.click(within(movers).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
    fireEvent.click(within(activity).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 2));
  });

  it("a loaded `[]`: `No product movement in the last 7 days.` and `No recent activity.`", async () => {
    mockFetch({ ok: true, body: { ...LOADED, topMovingProducts: [], recentActivity: [] } });
    renderPage();

    expect(
      await within(card("Top Moving Products")).findByText("No product movement in the last 7 days."),
    ).toBeInTheDocument();
    expect(within(card("Recent Activity")).getByText("No recent activity.")).toBeInTheDocument();
  });

  it("loaded rows render as today, and the strip shows the numbers", async () => {
    mockFetch({ ok: true, body: LOADED });
    renderPage();

    expect(await within(card("Top Moving Products")).findByText("Widget")).toBeInTheDocument();
    expect(within(card("Top Moving Products")).getByText("42 units")).toBeInTheDocument();
    expect(within(card("Recent Activity")).getByText("kris")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("1 pending approval")).toBeInTheDocument();
    expect(screen.queryByText("--")).toBeNull();
  });

  it("a failed POLL over loaded data keeps the data and shows no error copy", async () => {
    mockFetch({ ok: true, body: LOADED });
    renderPage();
    expect(await within(card("Top Moving Products")).findByText("Widget")).toBeInTheDocument();

    mockFetch("error");
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["admin", "dashboard"] });
    });
    expect(qc.getQueryState(["admin", "dashboard"])?.status).toBe("error");
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(within(card("Top Moving Products")).getByText("Widget")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load product movement.")).toBeNull();
    expect(screen.queryByText("Couldn't load recent activity.")).toBeNull();
    expect(screen.queryByText("--")).toBeNull();
  });
});
