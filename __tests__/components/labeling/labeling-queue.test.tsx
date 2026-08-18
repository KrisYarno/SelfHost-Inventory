/** @jest-environment jsdom */
/**
 * THE LABELING QUEUE (contract pack C5.1/C5.2, spec §4.3).
 *
 * The queue is the bench: everything somebody verified and nobody has finished
 * stocking, oldest first, grouped by the delivery it came in on. The pins here
 * are the four places a plausible-looking queue would say something the database
 * did not:
 *
 *   1. THE COUNTS ARE THE SERVER'S. verified / stocked / remaining arrive
 *      computed; the screen prints them and derives nothing.
 *   2. THE BOUND IS TRUTHFUL. `moreCount` is what the COUNT and the LIMIT
 *      disagree by, and a page that shows 2 of 102 lines says so — otherwise
 *      "the queue is empty" means "the first hundred are done".
 *   3. `exceptionKeys` IS `[]` ON THIS PATH (amendment 4a). The queue's read
 *      does not join exceptions, so the screen must not read the empty array as
 *      "this line has no exceptions" — it says nothing about them at all.
 *   4. THE BATCH ROW IS MOUNTED, NOT REBUILT (S21). One implementation of
 *      idempotency and the cost prompt, mounted here and in the order detail.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
}));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: 7, isAdmin: true, defaultLocationId: 1 } } }),
}));
const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: jest.fn(),
  },
}));

// The shared row is MOUNTED here (S21) — stubbed so this suite pins the mount
// and its props rather than re-testing M4b's row.
jest.mock("@/components/labeling/batch-row", () => ({
  BatchRow: (props: {
    orderId: string;
    lineId: number;
    remaining: number;
    priorLocationId: number | null;
    locations: { id: number; name: string }[];
  }) => (
    <div
      data-testid={`batch-row-${props.lineId}`}
      data-order-id={props.orderId}
      data-remaining={String(props.remaining)}
      data-prior-location={String(props.priorLocationId)}
      data-locations={props.locations.map((location) => location.id).join(",")}
    />
  ),
}));

import { LabelingQueue } from "@/components/labeling/labeling-queue";

const ORDER_A = "cksupply000000000000000001";
const ORDER_B = "cksupply000000000000000002";

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

/** A queue line exactly as `SupplyOrderLineView` arrives over the wire. */
function line(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    orderedProductId: 11,
    productId: 11,
    productName: "Peptide A 5mg",
    status: "VERIFIED",
    orderedQuantity: 100,
    verifiedQuantity: 96,
    stockedQuantity: 0,
    disposedQuantity: 0,
    remaining: 96,
    lineTotalCents: 120000,
    unitCostCents: 1250,
    derivation: "$1,200.00 / 96 verified = $12.50/unit",
    labelingRequired: true,
    locationId: null,
    verifiedAt: "2026-08-15T10:00:00.000Z",
    verifiedBy: 7,
    discrepancy: null,
    // The queue's read does not join exceptions — ALWAYS `[]` here.
    exceptionKeys: [],
    ...over,
  };
}

function group(over: Record<string, unknown> = {}, lines = [line()]) {
  return {
    order: {
      id: ORDER_A,
      status: "RECEIVING",
      supplier: "Acme Peptides",
      supplierRef: "PO-4471",
      orderedAt: "2026-08-10T00:00:00.000Z",
      ...over,
    },
    lines,
  };
}

/** The queue GET envelope (amendment 4d): `{ groups, count, moreCount }`. */
function queuePayload(
  groups: ReturnType<typeof group>[],
  count = groups.reduce((total, entry) => total + entry.lines.length, 0),
  moreCount = 0,
) {
  return { groups, count, moreCount };
}

function respondWith(payload: unknown, status = 200) {
  mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("/api/locations")) {
      return jsonResponse(200, [
        { id: 1, name: "Main" },
        { id: 2, name: "Cold room" },
      ]);
    }
    if (target.includes("/api/labeling/queue")) return jsonResponse(status, payload);
    return jsonResponse(200, {});
  });
}

function renderQueue(orderId?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LabelingQueue orderId={orderId} />
    </QueryClientProvider>,
  );
}

function queueCalls(): string[] {
  return mockFetch.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes("/api/labeling/queue"));
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

it("groups lines under their order and links the header to the order detail", async () => {
  respondWith(
    queuePayload([
      group({}, [line({ id: 501 })]),
      group({ id: ORDER_B, supplier: "Bench Supply", supplierRef: "PO-9002" }, [
        line({ id: 777, productName: "Peptide B 10mg" }),
      ]),
    ]),
  );

  renderQueue();

  const first = await screen.findByTestId(`labeling-group-${ORDER_A}`);
  const second = screen.getByTestId(`labeling-group-${ORDER_B}`);

  expect(within(first).getByRole("link", { name: /PO-4471/ })).toHaveAttribute(
    "href",
    `/receiving/${ORDER_A}`,
  );
  expect(within(first).getByText(/Acme Peptides/)).toBeInTheDocument();
  // `orderedAt` is a UTC calendar day — never shifted into local time.
  expect(within(first).getByText(/2026-08-10/)).toBeInTheDocument();
  expect(within(second).getByRole("link", { name: /PO-9002/ })).toHaveAttribute(
    "href",
    `/receiving/${ORDER_B}`,
  );

  // Each line sits inside its own order's group, not a flat list.
  expect(within(first).getByTestId("labeling-line-501")).toBeInTheDocument();
  expect(within(second).getByTestId("labeling-line-777")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The labeling flag + progress
// ---------------------------------------------------------------------------

it("tags a skip-label line 'ready to stock' and a labeled line as labeling required", async () => {
  respondWith(
    queuePayload([
      group({}, [
        line({ id: 501, labelingRequired: true }),
        line({ id: 502, labelingRequired: false }),
      ]),
    ]),
  );

  renderQueue();

  const labeled = await screen.findByTestId("labeling-line-501");
  const ready = screen.getByTestId("labeling-line-502");

  expect(within(ready).getByText(/ready to stock/i)).toBeInTheDocument();
  expect(within(labeled).queryByText(/ready to stock/i)).not.toBeInTheDocument();
  expect(within(labeled).getByText(/labeling required/i)).toBeInTheDocument();
});

it("prints the server's progress — stocked x / verified y — and the remainder", async () => {
  respondWith(
    queuePayload([
      group({}, [
        line({ id: 501, verifiedQuantity: 96, stockedQuantity: 40, disposedQuantity: 2, remaining: 54 }),
      ]),
    ]),
  );

  renderQueue();

  expect(await screen.findByTestId("labeling-progress-501")).toHaveTextContent(
    "stocked 40 / verified 96",
  );
  const row = screen.getByTestId("labeling-line-501");
  expect(within(row).getByTestId("labeling-remaining-501")).toHaveTextContent("54");
  expect(within(row).getByTestId("labeling-disposed-501")).toHaveTextContent("2");
});

it("says NOTHING about exceptions — the queue's read does not join them", async () => {
  respondWith(queuePayload([group({}, [line({ id: 501, exceptionKeys: [] })])]));

  renderQueue();

  await screen.findByTestId("labeling-line-501");
  expect(screen.queryByText(/no exceptions/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/nothing to follow up/i)).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The shared batch row (S21)
// ---------------------------------------------------------------------------

it("mounts the shared batch row for every line with the line's own props", async () => {
  respondWith(
    queuePayload([
      group({}, [
        line({ id: 501, remaining: 96, locationId: null }),
        line({ id: 502, remaining: 10, locationId: 2 }),
      ]),
    ]),
  );

  renderQueue();

  const first = await screen.findByTestId("batch-row-501");
  expect(first).toHaveAttribute("data-order-id", ORDER_A);
  expect(first).toHaveAttribute("data-remaining", "96");
  expect(first).toHaveAttribute("data-prior-location", "null");
  // The locations catalog is fetched once and handed down.
  expect(first).toHaveAttribute("data-locations", "1,2");

  const second = screen.getByTestId("batch-row-502");
  expect(second).toHaveAttribute("data-remaining", "10");
  expect(second).toHaveAttribute("data-prior-location", "2");
});

// ---------------------------------------------------------------------------
// Discard remaining
// ---------------------------------------------------------------------------

it("shows the boundary sentence, requires a reason, and posts { reason }", async () => {
  const user = userEvent.setup();
  respondWith(queuePayload([group({}, [line({ id: 501, remaining: 96 })])]));

  renderQueue();

  await user.click(await screen.findByRole("button", { name: /discard remaining/i }));

  const panel = screen.getByTestId("discard-remaining-501");
  expect(
    within(panel).getByText(
      "Units verified but lost before stocking — this is a labeling loss, not a stock movement; a disposal recorded in error is corrected by re-raising the verified count in Receiving and stocking the units",
    ),
  ).toBeInTheDocument();

  // A reason is REQUIRED — the confirm is inert until one is typed.
  const confirm = within(panel).getByTestId("discard-remaining-confirm-501");
  expect(confirm).toBeDisabled();
  // REV-10 clause 10: the label carries NO cached number. The remainder the
  // server writes off is the one on the locked row, which may have moved since
  // this card was drawn.
  expect(confirm).toHaveTextContent("Write off the remainder");
  expect(confirm.textContent).not.toMatch(/\d/);

  await user.type(within(panel).getByTestId("discard-remaining-reason-501"), "vial broke on the bench");
  expect(confirm).toBeEnabled();
  await user.click(confirm);

  await waitFor(() => {
    const call = mockFetch.mock.calls.find((entry) =>
      String(entry[0]).includes("/discard-remaining"),
    );
    expect(call).toBeDefined();
    expect(String(call![0])).toBe(
      `/api/inbound-shipments/${ORDER_A}/lines/501/discard-remaining`,
    );
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      reason: "vial broke on the bench",
    });
  });
});

it("shows the server's refusal VERBATIM when the remainder is already gone", async () => {
  const user = userEvent.setup();
  mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("/api/locations")) return jsonResponse(200, []);
    if (target.includes("/discard-remaining")) {
      return jsonResponse(409, {
        error: "Nothing remains to discard on this line (stocked 96, disposed 0 of 96 verified)",
        code: "NOT_BOOKABLE",
      });
    }
    return jsonResponse(200, queuePayload([group({}, [line({ id: 501 })])]));
  });

  renderQueue();

  await user.click(await screen.findByRole("button", { name: /discard remaining/i }));
  await user.type(screen.getByTestId("discard-remaining-reason-501"), "spilled");
  await user.click(screen.getByTestId("discard-remaining-confirm-501"));

  expect(await screen.findByTestId("labeling-refusal-501")).toHaveTextContent(
    "Nothing remains to discard on this line (stocked 96, disposed 0 of 96 verified)",
  );
});

// ---------------------------------------------------------------------------
// The bound, the empty state, the failed read
// ---------------------------------------------------------------------------

it("says how many more lines the bound left out", async () => {
  respondWith(queuePayload([group({}, [line({ id: 501 }), line({ id: 502 })])], 102, 100));

  renderQueue();

  expect(await screen.findByTestId("labeling-queue-more")).toHaveTextContent("100 more");
});

it("renders no bound cue when the whole queue fits", async () => {
  respondWith(queuePayload([group({}, [line({ id: 501 })])]));

  renderQueue();

  await screen.findByTestId("labeling-line-501");
  expect(screen.queryByTestId("labeling-queue-more")).not.toBeInTheDocument();
});

it("renders the empty state when nothing is waiting", async () => {
  respondWith(queuePayload([]));

  renderQueue();

  expect(await screen.findByTestId("labeling-queue-empty")).toHaveTextContent(
    "Nothing to label — verified lines land here",
  );
});

it("renders the error INSTEAD OF the empty state when the read fails", async () => {
  respondWith({ error: "Failed to load the labeling queue" }, 500);

  renderQueue();

  expect(await screen.findByTestId("labeling-queue-error")).toHaveTextContent(
    "Failed to load the labeling queue",
  );
  expect(screen.queryByTestId("labeling-queue-empty")).not.toBeInTheDocument();
  expect(screen.queryByText(/Nothing to label/)).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The `?orderId=` deep link
// ---------------------------------------------------------------------------

it("asks for ONE order when deep-linked and offers a way back to the whole queue", async () => {
  respondWith(queuePayload([group({}, [line({ id: 501 })])]));

  renderQueue(ORDER_A);

  await screen.findByTestId("labeling-line-501");
  expect(queueCalls()[0]).toBe(`/api/labeling/queue?orderId=${ORDER_A}`);
  expect(screen.getByRole("link", { name: /show all/i })).toHaveAttribute("href", "/labeling");
});

it("asks for the WHOLE queue when no order is named, and shows no 'show all'", async () => {
  respondWith(queuePayload([group({}, [line({ id: 501 })])]));

  renderQueue();

  await screen.findByTestId("labeling-line-501");
  expect(queueCalls()[0]).toBe("/api/labeling/queue");
  expect(screen.queryByRole("link", { name: /show all/i })).not.toBeInTheDocument();
});

it("keeps the empty state truthful when a deep link matches nothing", async () => {
  respondWith(queuePayload([]));

  renderQueue(ORDER_B);

  expect(await screen.findByTestId("labeling-queue-empty")).toHaveTextContent(
    "Nothing to label — verified lines land here",
  );
  expect(screen.getByRole("link", { name: /show all/i })).toHaveAttribute("href", "/labeling");
});
