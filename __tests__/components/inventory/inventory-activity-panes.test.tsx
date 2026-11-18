/** @jest-environment jsdom */
//
// Facelift F0-4 (plan 2026-11-17-facelift-f0, F0-4 + the REV 2 folds) — the
// Inventory page's two lazy tab panes are never "empty" while loading or after
// a failure.
//
// Before: `logsQuery.data ?? []` and `transfersQuery.data ?? []` went straight
// into the tables, so a read still in flight — or one that failed — rendered
// "No inventory logs found" / "No transfer activity recorded yet." Now each
// pane passes its query state through: `Loading activity…` / `Loading
// transfers…` (role="status") while pending, `Couldn't load …` + Retry when the
// read failed with nothing loaded, and the empty copy only on a successful
// empty answer.

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
jest.mock("@/components/inventory/quick-adjust-dialog", () => ({ QuickAdjustDialog: () => null }));
jest.mock("@/components/inventory/stock-in-dialog", () => ({ StockInDialog: () => null }));
jest.mock("@/components/inventory/transfer-dialog", () => ({ TransferDialog: () => null }));

import InventoryPage from "@/app/(app)/inventory/page";

type Mode = "pending" | "error" | "empty";

const variantsBody = {
  products: [
    {
      id: 1,
      name: "P1",
      baseName: "Cat1",
      variant: null,
      combinedMinimum: 0,
      locations: [{ locationId: 1, locationName: "Main", quantity: 1, minQuantity: 0 }],
      totalQuantity: 1,
    },
  ],
  pagination: { page: 1, pageSize: 12, total: 1, totalPages: 1, hasMore: false },
};

let fetchMock: jest.Mock;
function mockFetch(logs: Mode, transfers: Mode) {
  const reply = (mode: Mode, key: "logs" | "transfers") => {
    if (mode === "pending") return new Promise<Response>(() => {});
    if (mode === "error") {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({ [key]: [] }) } as Response);
  };
  fetchMock = jest.fn((input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/api/inventory/variants")) {
      return Promise.resolve({ ok: true, json: async () => variantsBody } as Response);
    }
    if (u.includes("/api/inventory/logs")) return reply(logs, "logs");
    if (u.includes("/api/inventory/transfers")) return reply(transfers, "transfers");
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

const callsTo = (fragment: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(fragment));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InventoryPage />
    </QueryClientProvider>,
  );
}

async function openTransfersTab() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Transfers" }));
}

describe("F0-4 — the Recent Activity pane", () => {
  it("while loading: `Loading activity…` with role=status, never the empty copy", async () => {
    mockFetch("pending", "empty");
    renderPage();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Loading activity…");
    expect(screen.queryByText("No inventory logs found")).toBeNull();
  });

  it("a failed read: `Couldn't load activity.` + Retry that refetches, never the empty copy", async () => {
    mockFetch("error", "empty");
    renderPage();
    expect(await screen.findByText("Couldn't load activity.")).toBeInTheDocument();
    expect(screen.queryByText("No inventory logs found")).toBeNull();

    const before = callsTo("/api/inventory/logs").length;
    const block = screen.getByText("Couldn't load activity.").parentElement as HTMLElement;
    fireEvent.click(within(block).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callsTo("/api/inventory/logs").length).toBe(before + 1));
  });

  it("a successful empty answer shows the table's empty copy", async () => {
    mockFetch("empty", "empty");
    renderPage();
    expect((await screen.findAllByText("No inventory logs found")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("F0-4 — the Transfers pane", () => {
  it("while loading: `Loading transfers…` with role=status, never the empty copy", async () => {
    mockFetch("empty", "pending");
    renderPage();
    await openTransfersTab();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Loading transfers…");
    expect(screen.queryByText("No transfer activity recorded yet.")).toBeNull();
  });

  it("a failed read: `Couldn't load transfers.` + Retry that refetches, never the empty copy", async () => {
    mockFetch("empty", "error");
    renderPage();
    await openTransfersTab();
    expect(await screen.findByText("Couldn't load transfers.")).toBeInTheDocument();
    expect(screen.queryByText("No transfer activity recorded yet.")).toBeNull();

    const before = callsTo("/api/inventory/transfers").length;
    const block = screen.getByText("Couldn't load transfers.").parentElement as HTMLElement;
    fireEvent.click(within(block).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callsTo("/api/inventory/transfers").length).toBe(before + 1));
  });

  it("a successful empty answer shows the table's empty copy", async () => {
    mockFetch("empty", "empty");
    renderPage();
    await openTransfersTab();
    expect(await screen.findByText("No transfer activity recorded yet.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
