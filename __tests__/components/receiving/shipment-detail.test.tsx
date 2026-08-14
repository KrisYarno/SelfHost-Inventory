/** @jest-environment jsdom */
/**
 * W1-4b — the receiving DETAIL (seam S10 + the T4 state matrix, rendered).
 *
 * This is the surface the whole lane was built for: the place where a receipt's
 * lines are counted, priced, and turned into stock, with the discrepancy
 * visible the entire time.
 *
 * What is pinned here:
 *   - the per-line flags from W1-2a's arithmetic, INCLUDING the NULL-expected
 *     rule (an unexpected arrival counts in full and says so);
 *   - the count control posting to W1-2b's endpoint and adopting the SERVER's
 *     number — never the one that was typed;
 *   - the per-line cost writing `unitCostCents` through the staging PATCH;
 *   - close / cancel per the state matrix, with the close-with-uncounted 409
 *     SURFACED (listing the lines that blocked it) rather than swallowed;
 *   - cancel asking first, because it unlinks every line;
 *   - CLOSED and CANCELLED shipments refusing receiving work in the UI, so the
 *     server's 409 is a backstop rather than the first thing an operator meets.
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
const toastError = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: jest.fn(),
    warning: jest.fn(),
  },
}));

import { ShipmentDetail } from "@/components/receiving/shipment-detail";

const SHIPMENT_ID = "ckship0000000000000000001";

function line(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    description: "Vials 10ml",
    status: "RECEIVED",
    expectedQuantity: 10,
    countedQuantity: null,
    unitCostCents: null,
    resolvedProductId: null,
    locationId: 1,
    vendor: "Acme",
    reference: "PO-1001",
    notes: null,
    receivedAt: new Date().toISOString(),
    countedAt: null,
    countedBy: null,
    location: { id: 1, name: "Main" },
    resolvedProduct: null,
    flags: { counted: false, expectedMissing: false, delta: null, direction: null },
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}, items = [line()]) {
  return {
    id: SHIPMENT_ID,
    supplierRef: "PO-1001",
    status: "OPEN",
    notes: null,
    createdBy: 7,
    closedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    creator: { id: 7, username: "kris" },
    itemCount: items.length,
    receivedItemCount: items.filter((i) => i.status === "RECEIVED").length,
    graduatedItemCount: items.filter((i) => i.status === "GRADUATED").length,
    uncountedReceivedItemCount: items.filter(
      (i) => i.status === "RECEIVED" && i.countedQuantity === null,
    ).length,
    discrepancy: {
      itemCount: items.length,
      countedItemCount: 0,
      uncountedItemCount: items.length,
      discrepancyItemCount: 0,
      totalOver: 0,
      totalUnder: 0,
    },
    items,
    ...over,
  };
}

type Responder = (url: string, init?: RequestInit) => unknown | undefined;

/**
 * The detail's whole request surface. `extra` lets a test override one endpoint
 * (a 409, say) without restating the rest.
 */
function mockFetch(body: unknown, extra?: Responder) {
  const fn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const override = extra?.(u, init);
    if (override !== undefined) return override as Response;

    if (u.includes(`/api/inbound-shipments/${SHIPMENT_ID}`)) {
      return { ok: true, json: async () => body } as unknown as Response;
    }
    if (u.includes("/api/staging-items") && u.includes("/count")) {
      const sent = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        json: async () => ({
          id: 11,
          status: "RECEIVED",
          // The SERVER's number, deliberately different from what was typed.
          countedQuantity: sent.countedQuantity,
          previousCountedQuantity: null,
          recount: false,
          countedBy: 7,
          countedAt: new Date().toISOString(),
          expectedQuantity: 10,
          shipmentId: SHIPMENT_ID,
          discrepancy: {
            counted: true,
            expectedMissing: false,
            delta: sent.countedQuantity - 10,
            direction: sent.countedQuantity > 10 ? "OVER" : "UNDER",
          },
        }),
      } as unknown as Response;
    }
    if (u.includes("/api/staging-items")) {
      return { ok: true, json: async () => ({ items: [] }) } as unknown as Response;
    }
    if (u.includes("/api/locations")) {
      return {
        ok: true,
        json: async () => [{ id: 1, name: "Main" }],
      } as unknown as Response;
    }
    if (u.includes("/api/products")) {
      return {
        ok: true,
        json: async () => ({ products: [{ id: 7, name: "Widget 10ml" }] }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function renderDetail(body: unknown = detail(), extra?: Responder) {
  const fetchFn = mockFetch(body, extra);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ShipmentDetail shipmentId={SHIPMENT_ID} />
    </QueryClientProvider>,
  );
  return { ...utils, fetchFn };
}

/**
 * Type a freight bill and FREEZE it (FD-1): Allocate is the calculator's session
 * start, and everything it computes hangs off the costs as they were then.
 */
async function enterBill(user: ReturnType<typeof userEvent.setup>, dollars: string) {
  await user.type(screen.getByLabelText(/freight/i), dollars);
  await user.click(screen.getByRole("button", { name: /allocate/i }));
}

const lineRow = (id: number) => screen.getByTestId(`receiving-line-${id}`);
const fetchSpy = () => global.fetch as unknown as jest.Mock;
const writesTo = (fn: jest.Mock, fragment: string) =>
  fn.mock.calls.filter(
    (c) => String(c[0]).includes(fragment) && (c[1] as RequestInit)?.method !== undefined,
  );

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Header + per-line flags
// ---------------------------------------------------------------------------

describe("the header and its lines", () => {
  it("renders the header and every linked line", async () => {
    renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(screen.getByTestId("shipment-header")).toHaveTextContent("PO-1001");
    expect(lineRow(11)).toHaveTextContent("Vials 10ml");
  });

  it("shows an uncounted line as UNCOUNTED, never as a match", async () => {
    renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    const flag = within(lineRow(11)).getByTestId("line-flag");
    expect(flag).toHaveTextContent(/not counted/i);
    expect(flag).not.toHaveTextContent(/match/i);
  });

  it("shows the signed delta on a counted line that missed", async () => {
    renderDetail(
      detail({}, [
        line({
          countedQuantity: 7,
          flags: { counted: true, expectedMissing: false, delta: -3, direction: "UNDER" },
        }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(within(lineRow(11)).getByTestId("line-flag")).toHaveTextContent(/3 under/i);
  });

  it("names an UNEXPECTED arrival (NULL expected counts in full)", async () => {
    renderDetail(
      detail({}, [
        line({
          expectedQuantity: null,
          countedQuantity: 4,
          flags: { counted: true, expectedMissing: true, delta: 4, direction: "OVER" },
        }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    const flag = within(lineRow(11)).getByTestId("line-flag");
    expect(flag).toHaveTextContent(/unexpected/i);
    expect(flag).toHaveTextContent(/4 over/i);
  });
});

// ---------------------------------------------------------------------------
// The count control (W1-2b's endpoint)
// ---------------------------------------------------------------------------

describe("the count control", () => {
  it("posts to the COUNT endpoint and adopts the server's number", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.type(within(lineRow(11)).getByLabelText(/count/i), "12");
    await user.click(within(lineRow(11)).getByRole("button", { name: /save count/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/count").length).toBe(1));
    const [, init] = writesTo(fetchFn, "/count")[0];
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      countedQuantity: 12,
    });
  });

  it("accepts a count of 0 — an empty box is a fact", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.type(within(lineRow(11)).getByLabelText(/count/i), "0");
    await user.click(within(lineRow(11)).getByRole("button", { name: /save count/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/count").length).toBe(1));
  });

  it("offers no count control on a GRADUATED line", async () => {
    renderDetail(detail({}, [line({ status: "GRADUATED", countedQuantity: 10 })]));

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(
      within(lineRow(11)).queryByRole("button", { name: /save count/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Per-line cost (the staging PATCH)
// ---------------------------------------------------------------------------

describe("the per-line cost", () => {
  it("writes unitCostCents through the staging PATCH", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.type(within(lineRow(11)).getByLabelText(/unit cost/i), "12.50");
    await user.click(within(lineRow(11)).getByRole("button", { name: /save cost/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/api/staging-items/11").length).toBe(1));
    const [, init] = writesTo(fetchFn, "/api/staging-items/11")[0];
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      unitCostCents: 1250,
    });
  });

  it("renders an unpriced line as unknown, never as $0.00", async () => {
    renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(within(lineRow(11)).getByTestId("line-cost")).not.toHaveTextContent("$0.00");
    expect(within(lineRow(11)).getByTestId("line-cost")).toHaveTextContent(/not priced/i);
  });

  it("renders a genuine zero cost as $0.00 — a free sample is a fact", async () => {
    renderDetail(detail({}, [line({ unitCostCents: 0 })]));

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(within(lineRow(11)).getByTestId("line-cost")).toHaveTextContent("$0.00");
  });
});

// ---------------------------------------------------------------------------
// The state matrix: close / cancel / unlink
// ---------------------------------------------------------------------------

describe("close", () => {
  it("PATCHes the shipment to CLOSED", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail(
      detail({ uncountedReceivedItemCount: 0 }, [line({ countedQuantity: 10 })]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /close shipment/i }));

    await waitFor(() =>
      expect(writesTo(fetchFn, `/api/inbound-shipments/${SHIPMENT_ID}`).length).toBe(1),
    );
    const [, init] = writesTo(fetchFn, `/api/inbound-shipments/${SHIPMENT_ID}`)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ status: "CLOSED" });
  });

  it("SURFACES the close-with-uncounted 409, naming the lines that blocked it", async () => {
    const user = userEvent.setup();
    renderDetail(detail(), (url, init) => {
      if (url.includes(`/api/inbound-shipments/${SHIPMENT_ID}`) && init?.method === "PATCH") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Inbound shipment has uncounted received items and cannot be closed",
            code: "CONFLICT",
            uncountedItemIds: [11, 12],
          }),
        };
      }
      return undefined;
    });

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /close shipment/i }));

    const blocker = await screen.findByTestId("close-blocked");
    expect(blocker).toHaveTextContent(/uncounted/i);
    expect(blocker).toHaveTextContent("11");
    expect(blocker).toHaveTextContent("12");
  });

  it("warns before the attempt when lines are still uncounted", async () => {
    renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(screen.getByTestId("uncounted-warning")).toHaveTextContent(/1/);
  });
});

describe("cancel", () => {
  it("asks first — cancelling unlinks every line", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    const { fetchFn } = renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /cancel shipment/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(writesTo(fetchFn, `/api/inbound-shipments/${SHIPMENT_ID}`)).toHaveLength(0);
    confirmSpy.mockRestore();
  });

  it("PATCHes to CANCELLED once confirmed", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    const { fetchFn } = renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /cancel shipment/i }));

    await waitFor(() =>
      expect(writesTo(fetchFn, `/api/inbound-shipments/${SHIPMENT_ID}`).length).toBe(1),
    );
    const [, init] = writesTo(fetchFn, `/api/inbound-shipments/${SHIPMENT_ID}`)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      status: "CANCELLED",
    });
    confirmSpy.mockRestore();
  });
});

describe("unlink", () => {
  it("clears shipmentId through the staging PATCH", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail();

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(within(lineRow(11)).getByRole("button", { name: /unlink/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/api/staging-items/11").length).toBe(1));
    const [, init] = writesTo(fetchFn, "/api/staging-items/11")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ shipmentId: null });
  });
});

// ---------------------------------------------------------------------------
// Settled shipments stop offering receiving work
// ---------------------------------------------------------------------------

describe("a settled shipment", () => {
  it("a CLOSED shipment offers no count, no link and no close", async () => {
    renderDetail(
      detail({ status: "CLOSED", closedAt: new Date().toISOString(), closedBy: 7 }, [
        line({ countedQuantity: 10 }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: /close shipment/i }),
    ).not.toBeInTheDocument();
    expect(
      within(lineRow(11)).queryByRole("button", { name: /save count/i }),
    ).not.toBeInTheDocument();
    expect(
      within(lineRow(11)).queryByRole("button", { name: /unlink/i }),
    ).not.toBeInTheDocument();
  });

  it("a CLOSED shipment STILL offers graduation (the stranded-line amendment)", async () => {
    renderDetail(
      detail({ status: "CLOSED", closedAt: new Date().toISOString(), closedBy: 7 }, [
        line({ countedQuantity: 10 }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(
      within(lineRow(11)).getByRole("button", { name: /graduate/i }),
    ).toBeInTheDocument();
  });

  it("a CANCELLED shipment offers nothing at all", async () => {
    renderDetail(detail({ status: "CANCELLED" }, [line({ countedQuantity: 10 })]));

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(
      within(lineRow(11)).queryByRole("button", { name: /graduate/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /cancel shipment/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The calculator, wired
// ---------------------------------------------------------------------------

describe("the freight calculator", () => {
  it("Accept writes each line's unitCostCents through the staging PATCH", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail(
      detail({}, [line({ countedQuantity: 10, unitCostCents: 500 })]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "10.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/api/staging-items/11").length).toBe(1));
    // The whole 1000c bill lands on the one line: 500 + 1000/10 = 600/unit.
    expect(
      JSON.parse(String((writesTo(fetchFn, "/api/staging-items/11")[0][1] as RequestInit).body)),
    ).toEqual({ unitCostCents: 600 });
  });

  it("is offered on a CLOSED shipment too — a stranded line still needs a cost", async () => {
    renderDetail(
      detail({ status: "CLOSED", closedAt: new Date().toISOString(), closedBy: 7 }, [
        line({ countedQuantity: 10, unitCostCents: 500 }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(screen.getByLabelText(/freight/i)).toBeInTheDocument();
  });

  it("is NOT offered on a CANCELLED shipment", async () => {
    renderDetail(detail({ status: "CANCELLED" }, [line({ countedQuantity: 10 })]));

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(screen.queryByLabelText(/freight/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // W1S-5 — the sequential PATCHes are not all-or-nothing, so a failure has to
  // say WHERE it stopped. Swallowing it left the operator with a cleared bill,
  // a success-shaped screen, and some lines priced and some not.
  // -------------------------------------------------------------------------

  it("a mid-sequence failure names the lines that DID write and keeps the bill", async () => {
    const user = userEvent.setup();
    let costPatches = 0;
    renderDetail(
      detail({}, [
        line({ id: 11, countedQuantity: 10, unitCostCents: 500 }),
        line({ id: 12, description: "Caps", countedQuantity: 5, unitCostCents: 200 }),
      ]),
      (url, init) => {
        if (url.includes("/api/staging-items/") && init?.method === "PATCH") {
          costPatches += 1;
          // the first line writes, the second one 500s
          if (costPatches === 1) return { ok: true, json: async () => ({ id: 11 }) };
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "Database is unavailable" }),
          };
        }
        return undefined;
      },
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    const report = await screen.findByTestId("cost-write-partial");
    // WHICH lines wrote — the whole point of not swallowing the throw.
    expect(report).toHaveTextContent("11");
    expect(report).toHaveTextContent(/not written/i);
    expect(report).toHaveTextContent("12");
    // The panel kept the bill, so the operator can retry the rest.
    expect(screen.getByLabelText(/freight/i)).toHaveValue("60.00");
    expect(await screen.findByTestId("allocation-write-failed")).toBeInTheDocument();
  });

  it("a fully successful Accept reports nothing partial (the success path is unchanged)", async () => {
    const user = userEvent.setup();
    renderDetail(detail({}, [line({ countedQuantity: 10, unitCostCents: 500 })]));

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "10.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(writesTo(fetchSpy(), "/api/staging-items/11").length).toBe(1));
    expect(screen.queryByTestId("cost-write-partial")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // FD-1 — the partial write, END TO END through the real hook.
  //
  // Each successful line PATCH invalidates the shipment query, so the lines that
  // wrote come back carrying their LANDED costs. The panel used to recompute
  // against them and the retry re-sent the written line at a higher number
  // again: 100c -> 200c -> 333c on a line nobody meant to touch twice. The
  // detail's job in that fix is to name the lines that DID write when it
  // rethrows; this pins that the two halves are actually wired together.
  // -------------------------------------------------------------------------

  it("a retry after a partial write sends ONLY the unwritten line (FD-1)", async () => {
    const user = userEvent.setup();
    // Two identical 100c lines of 10 units: 20.00 of freight lands 100c on each,
    // so each line's landed unit cost is 200c.
    let items = [
      line({ id: 11, countedQuantity: 10, unitCostCents: 100 }),
      line({ id: 12, description: "Caps", countedQuantity: 10, unitCostCents: 100 }),
    ];
    let firstAttempt = true;
    const { fetchFn } = renderDetail(detail(), (url, init) => {
      if (url.includes(`/api/inbound-shipments/${SHIPMENT_ID}`) && !init?.method) {
        return { ok: true, json: async () => detail({}, items) };
      }
      if (url.includes("/api/staging-items/") && init?.method === "PATCH") {
        if (url.includes("/11")) {
          // Line 11 writes — and the shipment now reports its LANDED cost.
          items = [line({ id: 11, countedQuantity: 10, unitCostCents: 200 }), items[1]];
          return { ok: true, json: async () => ({ id: 11 }) };
        }
        if (firstAttempt) {
          firstAttempt = false;
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "Database is unavailable" }),
          };
        }
        return { ok: true, json: async () => ({ id: 12 }) };
      }
      return undefined;
    });

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "20.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("cost-write-partial");

    // The refetch has landed: line 11 reads 200c now.
    await waitFor(() =>
      expect(within(lineRow(11)).getByTestId("line-cost")).toHaveTextContent("$2.00"),
    );

    await user.click(screen.getByRole("button", { name: /accept/i }));
    await waitFor(() => expect(writesTo(fetchFn, "/api/staging-items/12").length).toBe(2));

    // Line 11 was written ONCE, at 200c — never re-sent, never compounded.
    const line11Writes = writesTo(fetchFn, "/api/staging-items/11");
    expect(line11Writes).toHaveLength(1);
    expect(JSON.parse(String((line11Writes[0][1] as RequestInit).body))).toEqual({
      unitCostCents: 200,
    });
    // And the retry sent line 12 at the ORIGINAL allocation, not a re-split one.
    const line12Writes = writesTo(fetchFn, "/api/staging-items/12");
    expect(JSON.parse(String((line12Writes[1][1] as RequestInit).body))).toEqual({
      unitCostCents: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// W1S-8 — pricing outlives the close, exactly as graduation does.
// ---------------------------------------------------------------------------

describe("the per-line cost control follows STOCKING, not receiving (W1S-8)", () => {
  it("a CLOSED shipment still offers the cost input for its RECEIVED lines", async () => {
    renderDetail(
      detail({ status: "CLOSED", closedAt: new Date().toISOString(), closedBy: 7 }, [
        line({ countedQuantity: 10 }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    // A stranded line's graduation reads this cost, so pricing must still be
    // possible — while COUNTING (receiving work) is correctly gone.
    expect(within(lineRow(11)).getByLabelText(/unit cost/i)).toBeInTheDocument();
    expect(
      within(lineRow(11)).queryByLabelText(/^count$/i),
    ).not.toBeInTheDocument();
  });

  it("a CANCELLED shipment offers no cost input", async () => {
    renderDetail(detail({ status: "CANCELLED" }, [line({ countedQuantity: 10 })]));

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(within(lineRow(11)).queryByLabelText(/unit cost/i)).not.toBeInTheDocument();
  });

  it("a GRADUATED line offers no cost input even while the shipment is OPEN", async () => {
    renderDetail(detail({}, [line({ status: "GRADUATED", countedQuantity: 10 })]));

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    expect(within(lineRow(11)).queryByLabelText(/unit cost/i)).not.toBeInTheDocument();
  });

  it("writes the cost from a CLOSED shipment's line through the staging PATCH", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail(
      detail({ status: "CLOSED", closedAt: new Date().toISOString(), closedBy: 7 }, [
        line({ countedQuantity: 10 }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.type(within(lineRow(11)).getByLabelText(/unit cost/i), "12.50");
    await user.click(within(lineRow(11)).getByRole("button", { name: /save cost/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/api/staging-items/11").length).toBe(1));
    expect(
      JSON.parse(String((writesTo(fetchFn, "/api/staging-items/11")[0][1] as RequestInit).body)),
    ).toEqual({ unitCostCents: 1250 });
  });
});

// ---------------------------------------------------------------------------
// Graduation: the W1-3b cost prop, and the approval verdict
// ---------------------------------------------------------------------------

describe("graduation from the receiving detail", () => {
  async function openGraduate(unitCostCents: number | null) {
    const user = userEvent.setup();
    const rendered = renderDetail(
      detail({}, [line({ countedQuantity: 10, unitCostCents })]),
      (url, init) => {
        if (url.includes("/graduate") && init?.method === "POST") {
          return {
            ok: true,
            json: async () => ({
              productId: 77,
              // A non-admin's new product is booked WITH stock and held.
              approvalStatus: "PENDING_REVIEW",
              locationId: 1,
              countedQuantity: 10,
              bookedQuantity: 10,
              receiptCost: { unitCostCents, source: "line" },
              costPrompt: null,
            }),
          };
        }
        return undefined;
      },
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(within(lineRow(11)).getByRole("button", { name: /graduate/i }));
    await screen.findByRole("heading", { name: /graduate item/i });
    return { user, ...rendered };
  }

  it("threads the line's unitCostCents into the New-product cost field", async () => {
    const { user } = await openGraduate(1250);

    await user.click(screen.getByRole("button", { name: /new product/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/cost price/i)).toHaveValue(12.5),
    );
  });

  it("renders the read-only count from the ROW, never a typed field", async () => {
    await openGraduate(1250);

    const counted = screen.getByLabelText(/counted \(from the row\)/i);
    expect(counted).toHaveValue("10");
    expect(counted).toHaveAttribute("readonly");
  });

  it("says so when the graduated product is held for approval", async () => {
    const { user } = await openGraduate(1250);

    await user.type(screen.getByLabelText(/find a product/i), "widget");
    const result = await screen.findByRole("button", { name: /widget 10ml/i });
    await user.click(result);
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    const notice = await screen.findByTestId("pending-approval-notice");
    expect(notice).toHaveTextContent(/awaiting approval/i);
    expect(notice).toHaveTextContent("77");
  });
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

describe("failure", () => {
  it("says the shipment could not be loaded", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "Inbound shipment not found" }),
    })) as unknown as typeof fetch;
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ShipmentDetail shipmentId={SHIPMENT_ID} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("shipment-detail-error")).toBeInTheDocument(),
    );
  });
});
