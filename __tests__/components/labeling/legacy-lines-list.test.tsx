/** @jest-environment jsdom */
/**
 * THE PRE-STAGING ARCHIVE (contract pack C5.2, spec §4.3.6 / D8).
 *
 * The boxes of the flow this lane replaces, kept because the ROWS are kept: a
 * receipt somebody is asked about next year has to be findable. Two properties
 * are load-bearing:
 *
 *   1. IT IS READ-ONLY, structurally. No count, no graduate, no discard — the
 *      archive offers no control at all, so there is no affordance whose 4xx
 *      teaches people that refusals are noise.
 *   2. WHAT IS MISSING IS NAMED. A line with no resolved product and a location
 *      whose name did not come back are said out loud, never rendered as a blank
 *      cell that reads like "nothing was there".
 */

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LegacyLinesList } from "@/components/labeling/legacy-lines-list";

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A `LegacyLineView` exactly as `GET /api/receiving/legacy-lines` returns it. */
function legacyLine(over: Record<string, unknown> = {}) {
  return {
    id: 900,
    description: "Blue tote, unlabeled",
    status: "GRADUATED",
    productId: 11,
    productName: "Peptide A 5mg",
    expectedQuantity: 50,
    countedQuantity: 46,
    locationId: 1,
    locationName: "Main",
    receivedAt: "2026-07-02T15:30:00.000Z",
    receivedBy: 7,
    shipmentId: "cklegacy00000000000000001",
    ...over,
  };
}

function respondWith(lines: unknown[], status = 200, body?: unknown) {
  mockFetch.mockImplementation(async () =>
    jsonResponse(status, body ?? { lines }),
  );
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LegacyLinesList />
    </QueryClientProvider>,
  );
}

it("renders the box, its product, its location, its status and who received it", async () => {
  respondWith([legacyLine()]);

  renderList();

  const row = await screen.findByTestId("legacy-line-900");
  expect(within(row).getByText("Blue tote, unlabeled")).toBeInTheDocument();
  expect(within(row).getByText(/Peptide A 5mg/)).toBeInTheDocument();
  expect(within(row).getByText(/Main/)).toBeInTheDocument();
  expect(within(row).getByText("GRADUATED")).toBeInTheDocument();
  // The archive carries the receiver's ID and no username — it says the ID.
  expect(within(row).getByTestId("legacy-received-900")).toHaveTextContent("user 7");
});

it("links a linked box to its receipt and leaves an unlinked one unlinked", async () => {
  respondWith([
    legacyLine({ id: 900, shipmentId: "cklegacy00000000000000001" }),
    legacyLine({ id: 901, shipmentId: null }),
  ]);

  renderList();

  const linked = await screen.findByTestId("legacy-line-900");
  expect(within(linked).getByRole("link")).toHaveAttribute(
    "href",
    "/receiving/cklegacy00000000000000001",
  );
  const orphan = screen.getByTestId("legacy-line-901");
  expect(within(orphan).queryByRole("link")).toBeNull();
});

it("names what is missing instead of rendering a blank cell", async () => {
  respondWith([legacyLine({ id: 902, productName: null, productId: null, locationName: null, locationId: 4 })]);

  renderList();

  const row = await screen.findByTestId("legacy-line-902");
  expect(within(row).getByText(/No product linked/i)).toBeInTheDocument();
  expect(within(row).getByText(/Location 4/)).toBeInTheDocument();
});

it("offers NO control — the archive is read-only", async () => {
  respondWith([legacyLine()]);

  renderList();

  await screen.findByTestId("legacy-line-900");
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("renders the empty state when there is no history", async () => {
  respondWith([]);

  renderList();

  expect(await screen.findByTestId("legacy-lines-empty")).toBeInTheDocument();
});

it("renders the error INSTEAD OF the empty state when the read fails", async () => {
  respondWith([], 500, { error: "Failed to load the pre-staging history" });

  renderList();

  expect(await screen.findByTestId("legacy-lines-error")).toHaveTextContent(
    "Failed to load the pre-staging history",
  );
  expect(screen.queryByTestId("legacy-lines-empty")).not.toBeInTheDocument();
});
