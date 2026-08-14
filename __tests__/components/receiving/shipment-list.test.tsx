/** @jest-environment jsdom */
/**
 * W1-4b — the receiving LIST (seam S10: it consumes W1-2a's T4 shapes verbatim).
 *
 * Everything numeric on a receiving header is computed on read from the linked
 * staging lines, so this surface only has to render it honestly:
 *
 *   - over and under NEVER cancel. A shipment that is 5 over on one line and 3
 *     under on another reports both, because netting them to "+2" is exactly
 *     the blindness this lane exists to end;
 *   - UNCOUNTED is not zero. A line nobody has counted contributes nothing to
 *     the totals and is surfaced as its own count — it is also the only thing
 *     that blocks a close;
 *   - an OPEN shipment carries an AGING cue, because a receipt left open is a
 *     receipt nobody finished.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

import { ShipmentList } from "@/components/receiving/shipment-list";

const DAY = 24 * 60 * 60 * 1000;

function rollup(over = 0, under = 0, counted = 0, uncounted = 0) {
  return {
    itemCount: counted + uncounted,
    countedItemCount: counted,
    uncountedItemCount: uncounted,
    discrepancyItemCount: (over > 0 ? 1 : 0) + (under > 0 ? 1 : 0),
    totalOver: over,
    totalUnder: under,
  };
}

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "ckship0000000000000000001",
    supplierRef: "PO-1001",
    status: "OPEN",
    notes: null,
    createdBy: 7,
    closedBy: null,
    createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    creator: { id: 7, username: "kris" },
    itemCount: 2,
    receivedItemCount: 2,
    graduatedItemCount: 0,
    uncountedReceivedItemCount: 0,
    discrepancy: rollup(0, 0, 2, 0),
    ...over,
  };
}

function mockFetch(shipments: unknown[]) {
  const fn = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/inbound-shipments")) {
      return { ok: true, json: async () => ({ shipments }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function renderList(shipments: unknown[] = [summary()]) {
  const fetchFn = mockFetch(shipments);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ShipmentList />
    </QueryClientProvider>,
  );
  return { ...utils, fetchFn };
}

const row = (id: string) => screen.getByTestId(`shipment-row-${id}`);

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Rendering the T4 shape
// ---------------------------------------------------------------------------

describe("the list", () => {
  it("renders a shipment with its reference and a link to its detail", async () => {
    renderList();

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    expect(within(row("ckship0000000000000000001")).getByRole("link")).toHaveAttribute(
      "href",
      "/receiving/ckship0000000000000000001",
    );
    expect(row("ckship0000000000000000001")).toHaveTextContent("PO-1001");
  });

  it("falls back to the id when a shipment carries no supplier reference", async () => {
    renderList([summary({ supplierRef: null })]);

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    expect(row("ckship0000000000000000001")).toHaveTextContent(
      /ckship0000000000000000001/,
    );
  });

  it("shows over and under SEPARATELY — they never cancel", async () => {
    renderList([summary({ discrepancy: rollup(5, 3, 2, 0) })]);

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    const cell = within(row("ckship0000000000000000001")).getByTestId("discrepancy-cell");
    expect(cell).toHaveTextContent(/5 over/i);
    expect(cell).toHaveTextContent(/3 under/i);
    expect(cell).not.toHaveTextContent(/^2$/);
  });

  it("says so plainly when everything counted matched", async () => {
    renderList([summary({ discrepancy: rollup(0, 0, 2, 0) })]);

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    expect(
      within(row("ckship0000000000000000001")).getByTestId("discrepancy-cell"),
    ).toHaveTextContent(/no discrepanc/i);
  });

  it("reports uncounted lines as UNKNOWN, not as a match", async () => {
    renderList([
      summary({ uncountedReceivedItemCount: 2, discrepancy: rollup(0, 0, 0, 2) }),
    ]);

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    const cell = within(row("ckship0000000000000000001")).getByTestId("discrepancy-cell");
    expect(cell).toHaveTextContent(/2 uncounted/i);
    expect(cell).not.toHaveTextContent(/no discrepanc/i);
  });
});

// ---------------------------------------------------------------------------
// The aging cue
// ---------------------------------------------------------------------------

describe("the open-shipment aging cue", () => {
  it("shows how long an OPEN shipment has been open", async () => {
    renderList([summary({ createdAt: new Date(Date.now() - 5 * DAY).toISOString() })]);

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    expect(within(row("ckship0000000000000000001")).getByTestId("aging-cue"))
      .toHaveTextContent(/5 days/i);
  });

  it("flags a shipment that has been open too long", async () => {
    renderList([summary({ createdAt: new Date(Date.now() - 9 * DAY).toISOString() })]);

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    expect(
      within(row("ckship0000000000000000001")).getByTestId("aging-cue"),
    ).toHaveAttribute("data-stale", "true");
  });

  it("shows no aging cue on a CLOSED shipment — it is finished", async () => {
    renderList([
      summary({
        status: "CLOSED",
        closedAt: new Date().toISOString(),
        createdAt: new Date(Date.now() - 9 * DAY).toISOString(),
      }),
    ]);

    await waitFor(() => expect(row("ckship0000000000000000001")).toBeInTheDocument());
    expect(
      within(row("ckship0000000000000000001")).queryByTestId("aging-cue"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The status filter
// ---------------------------------------------------------------------------

describe("the status filter", () => {
  it("QA-6: opens on OPEN — the work in progress, not the whole archive", async () => {
    const { fetchFn } = renderList();

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(String(fetchFn.mock.calls[0][0])).toBe("/api/inbound-shipments?status=OPEN");
    // ...and the tab bar agrees with the request it just made.
    expect(screen.getByRole("button", { name: /^open$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^all$/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("QA-6: the whole archive is still one tap away", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderList();

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /^all$/i }));

    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some((c) => String(c[0]) === "/api/inbound-shipments"),
      ).toBe(true),
    );
  });

  it("passes the chosen status through as ?status=", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderList();

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /^closed$/i }));

    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some((c) =>
          String(c[0]).includes("/api/inbound-shipments?status=CLOSED"),
        ),
      ).toBe(true),
    );
  });
});

// ---------------------------------------------------------------------------
// Empty + failure
// ---------------------------------------------------------------------------

describe("empty and failing states", () => {
  it("offers the create affordance when there is nothing yet", async () => {
    renderList([]);

    await waitFor(() =>
      expect(screen.getByTestId("shipment-list-empty")).toBeInTheDocument(),
    );
    expect(screen.getAllByRole("button", { name: /new shipment/i }).length).toBeGreaterThan(0);
  });

  it("says the list could not be loaded rather than rendering an empty one", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    })) as unknown as typeof fetch;
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ShipmentList />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("shipment-list-error")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("shipment-list-empty")).not.toBeInTheDocument();
  });
});
