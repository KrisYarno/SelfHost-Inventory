/** @jest-environment jsdom */
/**
 * W2.5 — the pre-staging queue RENDERS the shipment context it already carried.
 *
 * `StagingItem.shipmentId` has been in this component's own data type since
 * W1-4b, and the table drew nothing with it: the operator surface for receiving
 * was blind to receiving. Two things follow from fixing that, and both are
 * pinned here:
 *
 *   - a linked row SAYS which receipt it belongs to, and that badge is the way
 *     into /receiving/[id];
 *   - an unlinked RECEIVED row can be attributed FROM HERE, through the same
 *     PATCH the receiving detail already uses — no cross-page ping-pong.
 *
 * The control pre-filters to OPEN headers because that is the only status a
 * link may be made against. Every other refusal (a header closed underneath a
 * held editor, a line that graduated mid-edit) belongs to the server, and its
 * sentence is rendered verbatim rather than second-guessed.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
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

import { StagingQueue, type StagingItem } from "@/components/staging/staging-queue";

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

const SHIP_A = "ckship0000000000000000aaa";
const SHIP_CLOSED = "ckship00000000000000shut";
const SHIP_NEW = "ckship0000000000000000new";

function summary(over: Record<string, unknown> = {}) {
  return {
    id: SHIP_A,
    supplierRef: "PO-1001",
    status: "OPEN",
    notes: null,
    createdBy: 7,
    closedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    creator: { id: 7, username: "kris" },
    itemCount: 0,
    receivedItemCount: 0,
    graduatedItemCount: 0,
    uncountedReceivedItemCount: 0,
    discrepancy: {
      itemCount: 0,
      countedItemCount: 0,
      uncountedItemCount: 0,
      discrepancyItemCount: 0,
      totalOver: 0,
      totalUnder: 0,
    },
    ...over,
  };
}

function item(over: Partial<StagingItem> = {}): StagingItem {
  return {
    id: 11,
    description: "Unlabeled box of vials",
    status: "RECEIVED",
    expectedQuantity: 10,
    countedQuantity: null,
    unitCostCents: null,
    shipmentId: null,
    vendor: "Acme",
    reference: "PO-1001",
    locationId: 1,
    receivedAt: new Date().toISOString(),
    location: { id: 1, name: "Main" },
    resolvedProduct: null,
    receivedByUser: { id: 7, username: "kris" },
    ...over,
  };
}

type Responder = (url: string, init?: RequestInit) => unknown | undefined;

function mockFetch(extra?: Responder) {
  const fn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const override = extra?.(u, init);
    if (override !== undefined) return override as Response;

    if (u.includes("/api/inbound-shipments")) {
      return { ok: true, json: async () => ({ shipments: [summary()] }) } as unknown as Response;
    }
    if (u.includes("/api/staging-items")) {
      return { ok: true, json: async () => ({ id: 11 }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function renderQueue(items: StagingItem[], extra?: Responder) {
  const fetchFn = mockFetch(extra);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <StagingQueue
        items={items}
        loading={false}
        onGraduate={jest.fn()}
        onDiscard={jest.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...utils, fetchFn };
}

const writes = (fn: jest.Mock) =>
  fn.mock.calls
    .filter((c) => (c[1] as RequestInit)?.method !== undefined)
    .map((c) => ({
      url: String(c[0]),
      method: (c[1] as RequestInit).method,
      body: (c[1] as RequestInit).body ? JSON.parse(String((c[1] as RequestInit).body)) : null,
    }));

const cell = (id: number) => screen.getByTestId(`staging-shipment-cell-${id}`);

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// PIN 4a — the badge
// ---------------------------------------------------------------------------

describe("the shipment badge", () => {
  it("names the receipt a linked row belongs to and links into it", async () => {
    renderQueue([item({ shipmentId: SHIP_A })]);

    await waitFor(() => expect(cell(11)).toHaveTextContent("PO-1001"));
    const link = cell(11).querySelector(`a[href="/receiving/${SHIP_A}"]`);
    expect(link).not.toBeNull();
  });

  it("falls back to a short id for a header it cannot name", async () => {
    renderQueue([item({ shipmentId: SHIP_CLOSED })]);

    // Not in the OPEN list, so there is no supplierRef to show — the short id
    // is still a true, clickable answer to "which receipt".
    await waitFor(() => expect(cell(11)).toHaveTextContent(/0shut/i));
    expect(cell(11).querySelector(`a[href="/receiving/${SHIP_CLOSED}"]`)).not.toBeNull();
  });

  it("says an unlinked box is unattributed rather than showing nothing", async () => {
    renderQueue([item()]);

    await waitFor(() => expect(cell(11)).toBeInTheDocument());
    expect(cell(11)).toHaveTextContent(/unattributed/i);
  });
});

// ---------------------------------------------------------------------------
// PIN 4b — assign, change, unlink
// ---------------------------------------------------------------------------

describe("assigning a box to a shipment", () => {
  it("offers Assign on an unlinked RECEIVED row and PATCHes the chosen header", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderQueue([item()]);

    await waitFor(() => expect(cell(11)).toBeInTheDocument());
    await user.click(within(cell(11)).getByRole("button", { name: /assign to shipment/i }));

    const editor = await screen.findByTestId("staging-assign-11");
    await user.click(within(editor).getByRole("combobox", { name: /receiving shipment/i }));
    await user.click(await screen.findByRole("option", { name: /PO-1001/ }));
    await user.click(within(editor).getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(writes(fetchFn).length).toBe(1));
    expect(writes(fetchFn)[0]).toMatchObject({
      method: "PATCH",
      body: { shipmentId: SHIP_A },
    });
    expect(writes(fetchFn)[0].url).toContain("/api/staging-items/11");
  });

  it("offers Change on a linked RECEIVED row, and unlinking PATCHes null", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderQueue([item({ shipmentId: SHIP_A })]);

    await waitFor(() => expect(cell(11)).toBeInTheDocument());
    await user.click(within(cell(11)).getByRole("button", { name: /change/i }));

    const editor = await screen.findByTestId("staging-assign-11");
    await user.click(within(editor).getByRole("combobox", { name: /receiving shipment/i }));
    await user.click(await screen.findByRole("option", { name: /none/i }));
    await user.click(within(editor).getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(writes(fetchFn).length).toBe(1));
    expect(writes(fetchFn)[0].body).toEqual({ shipmentId: null });
  });

  it("SURFACES the server's refusal verbatim and keeps the editor open", async () => {
    const user = userEvent.setup();
    renderQueue([item()], (url, init) => {
      if (url.includes("/api/staging-items/11") && init?.method === "PATCH") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Inbound shipment is not open and cannot be changed",
            code: "CONFLICT",
          }),
        };
      }
      return undefined;
    });

    await waitFor(() => expect(cell(11)).toBeInTheDocument());
    await user.click(within(cell(11)).getByRole("button", { name: /assign to shipment/i }));
    const editor = await screen.findByTestId("staging-assign-11");
    await user.click(within(editor).getByRole("combobox", { name: /receiving shipment/i }));
    await user.click(await screen.findByRole("option", { name: /PO-1001/ }));
    await user.click(within(editor).getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Inbound shipment is not open and cannot be changed",
      ),
    );
    expect(screen.getByTestId("staging-assign-11")).toBeInTheDocument();
  });

  it("offers no link control on a GRADUATED row — that receipt is history", async () => {
    renderQueue([item({ status: "GRADUATED", shipmentId: SHIP_A, countedQuantity: 10 })]);

    await waitFor(() => expect(cell(11)).toHaveTextContent("PO-1001"));
    expect(within(cell(11)).queryByRole("button")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// W25-1 PIN 3 — the queue's Save path keeps the header it opened
// ---------------------------------------------------------------------------

describe("an inline header opened from the queue editor", () => {
  it("is REUSED on the retry after the link is refused — never re-created", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderQueue([item()], (url, init) => {
      if (url.includes("/api/inbound-shipments") && init?.method === "POST") {
        return {
          ok: true,
          json: async () => summary({ id: SHIP_NEW, supplierRef: "PO-NEW" }),
        };
      }
      if (url.includes("/api/staging-items/11") && init?.method === "PATCH") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Item has already graduated", code: "CONFLICT" }),
        };
      }
      return undefined;
    });

    await waitFor(() => expect(cell(11)).toBeInTheDocument());
    await user.click(within(cell(11)).getByRole("button", { name: /assign to shipment/i }));
    const editor = await screen.findByTestId("staging-assign-11");
    await user.click(within(editor).getByRole("combobox", { name: /receiving shipment/i }));
    await user.click(await screen.findByRole("option", { name: /new shipment/i }));
    await user.click(within(editor).getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Item has already graduated"));

    // The editor is still open and the choice now NAMES the header it opened.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("staging-assign-11")).getByRole("combobox", {
          name: /receiving shipment/i,
        }),
      ).toHaveTextContent(/PO-NEW/),
    );

    await user.click(
      within(screen.getByTestId("staging-assign-11")).getByRole("button", { name: /^save$/i }),
    );

    await waitFor(() => expect(writes(fetchFn).filter((w) => w.method === "PATCH")).toHaveLength(2));
    const sent = writes(fetchFn);
    // ONE header, for two Saves.
    expect(sent.filter((w) => w.url.endsWith("/api/inbound-shipments"))).toHaveLength(1);
    expect(sent.filter((w) => w.method === "PATCH").map((w) => w.body)).toEqual([
      { shipmentId: SHIP_NEW },
      { shipmentId: SHIP_NEW },
    ]);
  });
});

// ---------------------------------------------------------------------------
// W25-2 PIN 4 + PIN 5 — Change is not offered against a SETTLED receipt
// ---------------------------------------------------------------------------
//
// A counted RECEIVED box legitimately stays linked after its receipt closes
// (the stranded-line amendment). `applyShipmentLink` demands BOTH headers OPEN,
// so every action from such a row is a guaranteed 409 — and "New shipment…"
// would mint an orphan header on the way to that refusal.

describe("a row whose receipt has settled", () => {
  const settled = () => [
    item({ id: 11, shipmentId: SHIP_A }),
    item({ id: 12, description: "Counted box", shipmentId: SHIP_CLOSED, countedQuantity: 4 }),
  ];

  it("shows the badge WITHOUT Change, while an OPEN-linked row keeps it", async () => {
    renderQueue(settled());

    // Wait for the OPEN list to LAND — before it does, membership is unknown.
    await waitFor(() => expect(cell(11)).toHaveTextContent("PO-1001"));

    expect(within(cell(11)).getByRole("button", { name: /change/i })).toBeInTheDocument();

    await waitFor(() =>
      expect(within(cell(12)).queryByRole("button", { name: /change/i })).not.toBeInTheDocument(),
    );
    expect(cell(12)).toHaveTextContent(/0shut/i);
    expect(cell(12)).toHaveTextContent(/receipt settled/i);
  });

  it("keeps Change when the list FAILED — unknown is not settled (fail-open)", async () => {
    const user = userEvent.setup();
    renderQueue(settled(), (url, init) => {
      if (url.includes("/api/inbound-shipments") && init?.method === undefined) {
        return { ok: false, status: 503, json: async () => ({ error: "Database is unavailable" }) };
      }
      return undefined;
    });

    // The picker is the surface that reports the failed read, so open one to
    // pin the read as DEFINITIVELY errored before asserting on the other row.
    await waitFor(() => expect(cell(11)).toBeInTheDocument());
    await user.click(within(cell(11)).getByRole("button", { name: /change/i }));
    const editor = await screen.findByTestId("staging-assign-11");
    expect(
      await within(editor).findByTestId("staging-shipment-11-list-error"),
    ).toHaveTextContent(/Database is unavailable/);

    // Row 12 is linked to a header the list cannot vouch for either way. It
    // keeps its action: a guaranteed-409 button beats a silently frozen row.
    expect(within(cell(12)).getByRole("button", { name: /change/i })).toBeInTheDocument();
    expect(cell(12)).not.toHaveTextContent(/receipt settled/i);
  });
});
