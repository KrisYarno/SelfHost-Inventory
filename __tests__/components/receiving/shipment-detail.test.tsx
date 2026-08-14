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

describe("cancel, blocked by graduated lines (QA-4)", () => {
  /** The T4 refusal a cancel meets when real stock already came off the receipt. */
  const graduatedRefusal = (url: string, init?: RequestInit) => {
    if (url.includes(`/api/inbound-shipments/${SHIPMENT_ID}`) && init?.method === "PATCH") {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error:
            "Inbound shipment has graduated lines and cannot be cancelled; unlink or reverse them first",
          code: "CONFLICT",
          graduatedItemIds: [11, 14],
        }),
      };
    }
    return undefined;
  };

  it("NAMES the graduated lines, exactly as a blocked close names the uncounted ones", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    renderDetail(detail(), graduatedRefusal);

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /cancel shipment/i }));

    // The server sends the ids so the operator can go and deal with THOSE lines;
    // rendering the sentence and dropping the list is a dead end.
    const blocker = await screen.findByTestId("cancel-blocked");
    expect(blocker).toHaveTextContent(/graduated/i);
    expect(blocker).toHaveTextContent("11");
    expect(blocker).toHaveTextContent("14");
    confirmSpy.mockRestore();
  });

  it("clears the block on the next attempt (it is about THIS attempt)", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    let refuse = true;
    renderDetail(detail(), (url, init) => {
      if (!refuse) return undefined;
      return graduatedRefusal(url, init);
    });

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /cancel shipment/i }));
    expect(await screen.findByTestId("cancel-blocked")).toBeInTheDocument();

    refuse = false;
    await user.click(screen.getByRole("button", { name: /cancel shipment/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("cancel-blocked")).not.toBeInTheDocument(),
    );
    confirmSpy.mockRestore();
  });

  it("still reports a cancel refusal that names nothing", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    renderDetail(detail(), (url, init) => {
      if (url.includes(`/api/inbound-shipments/${SHIPMENT_ID}`) && init?.method === "PATCH") {
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

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /cancel shipment/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.queryByTestId("cancel-blocked")).not.toBeInTheDocument();
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
  it("Accept sends the WHOLE bill to the batch route, in ONE request", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail(
      detail({}, [
        line({ id: 11, countedQuantity: 10, unitCostCents: 500 }),
        line({ id: 12, description: "Caps", countedQuantity: 5, unitCostCents: 200 }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/costs").length).toBe(1));
    const [, init] = writesTo(fetchFn, "/costs")[0];
    expect((init as RequestInit).method).toBe("POST");
    // 6000c of freight over values 5000 and 1000: 5000c and 1000c, i.e. +500 and
    // +200 per unit. Every line carries the frozen base as its precondition.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      lines: [
        { id: 11, unitCostCents: 1000, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 400, ifUnitCostCents: 200 },
      ],
    });
    // FD3-1: the per-line fan-out is GONE. Not one staging PATCH was sent.
    expect(writesTo(fetchFn, "/api/staging-items/")).toHaveLength(0);
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
  // FD3-1 (fix round 4) — THE BILL IS ONE TRANSACTION.
  //
  // W1S-5, FD-1 and FD3-1 were three readings of one defect: Accept fanned out
  // into a PATCH per line, and those PATCHes were not atomic. The last reading
  // is the one that costs money — line A lands, line B is refused, and the
  // recovery the panel offers ("clear and re-enter the FULL freight")
  // re-allocates the whole invoice INCLUDING onto A's base, which has already
  // absorbed its share. The landed cost of A is then overstated, silently, by
  // an operator following the instructions on screen.
  //
  // So Accept is now ONE POST of the whole bill, written in one transaction.
  // Everything below pins the two halves of that: on success every line wrote,
  // and on ANY failure nothing did — which is what makes "clear and re-enter"
  // safe again.
  // -------------------------------------------------------------------------

  it("PIN 1: a drifted line takes the WHOLE bill down — no line's cost changes", async () => {
    const user = userEvent.setup();
    // Two lines at 100c; whatever happens, neither may come back repriced.
    const items = [
      line({ id: 11, countedQuantity: 10, unitCostCents: 100 }),
      line({ id: 12, description: "Caps", countedQuantity: 10, unitCostCents: 100 }),
    ];
    const { fetchFn } = renderDetail(detail({}, items), (url, init) => {
      if (url.includes("/costs") && init?.method === "POST") {
        // The server refused line 12's precondition, so the transaction rolled
        // back — INCLUDING line 11's write, which had already run inside it.
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error:
              "Staging item 12: the cost changed while the bill was open; reload the shipment and re-enter the freight against the costs on screen",
            code: "COST_DRIFT",
          }),
        };
      }
      return undefined;
    });

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "20.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // ONE request, and it failed: nothing else was ever sent, so nothing landed.
    await waitFor(() => expect(writesTo(fetchFn, "/costs").length).toBe(1));
    expect(writesTo(fetchFn, "/api/staging-items/")).toHaveLength(0);
    // Both lines still read at their original cost — the recovery below cannot
    // double-apply freight onto a base that already absorbed some.
    expect(within(lineRow(11)).getByTestId("line-cost")).toHaveTextContent("$1.00");
    expect(within(lineRow(12)).getByTestId("line-cost")).toHaveTextContent("$1.00");
    // The panel shows the INVALIDATION, not a partial-write report.
    expect(await screen.findByTestId("allocation-invalidated")).toHaveTextContent(/cost/i);
    expect(screen.queryByTestId("cost-write-partial")).not.toBeInTheDocument();
    expect(screen.queryByTestId("line-written")).not.toBeInTheDocument();
    expect(screen.queryByTestId("allocation-applied")).not.toBeInTheDocument();
  });

  it("PIN 2: a successful bill writes every line and clears, with the applied notice", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail(
      detail({}, [
        line({ id: 11, countedQuantity: 10, unitCostCents: 100 }),
        line({ id: 12, description: "Caps", countedQuantity: 10, unitCostCents: 100 }),
      ]),
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "20.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(writesTo(fetchFn, "/costs").length).toBe(1));
    expect(JSON.parse(String((writesTo(fetchFn, "/costs")[0][1] as RequestInit).body))).toEqual({
      lines: [
        { id: 11, unitCostCents: 200, ifUnitCostCents: 100 },
        { id: 12, unitCostCents: 200, ifUnitCostCents: 100 },
      ],
    });
    expect(await screen.findByTestId("allocation-applied")).toBeInTheDocument();
    expect(screen.queryByTestId("cost-write-partial")).not.toBeInTheDocument();
  });

  it("QA-8: a line that GRADUATES mid-bill leaves the calculator and kills the session", async () => {
    const user = userEvent.setup();
    const twoReceived = detail({}, [
      line({ id: 11, countedQuantity: 10, unitCostCents: 100 }),
      line({ id: 12, description: "Caps", countedQuantity: 10, unitCostCents: 100 }),
    ]);
    const oneGraduated = detail({}, [
      line({ id: 11, countedQuantity: 10, unitCostCents: 100 }),
      line({
        id: 12,
        description: "Caps",
        status: "GRADUATED",
        countedQuantity: 10,
        unitCostCents: 100,
      }),
    ]);
    let body: unknown = twoReceived;
    renderDetail(twoReceived, (url, init) => {
      if (url.includes(`/api/inbound-shipments/${SHIPMENT_ID}`) && init?.method === undefined) {
        return { ok: true, json: async () => body };
      }
      return undefined;
    });

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "20.00");
    expect(screen.getByTestId("allocation-row-12")).toBeInTheDocument();

    // Somebody stocks that box while the bill is open. The refetch below drops
    // it from the calculator's world — a GRADUATED line is settled stock, and a
    // batch write against it can only ever be refused.
    body = oneGraduated;
    await user.type(within(lineRow(11)).getByLabelText(/count/i), "10");
    await user.click(within(lineRow(11)).getByRole("button", { name: /save count/i }));

    expect(await screen.findByTestId("allocation-invalidated")).toHaveTextContent(
      /no longer on this shipment/i,
    );
  });

  it("PIN 6: after a non-drift failure, Accept-again re-sends the IDENTICAL full bill", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { fetchFn } = renderDetail(
      detail({}, [
        line({ id: 11, countedQuantity: 10, unitCostCents: 100 }),
        line({ id: 12, description: "Caps", countedQuantity: 10, unitCostCents: 100 }),
      ]),
      (url, init) => {
        if (url.includes("/costs") && init?.method === "POST") {
          attempt += 1;
          if (attempt === 1) {
            return {
              ok: false,
              status: 500,
              json: async () => ({ error: "Database is unavailable" }),
            };
          }
          return undefined;
        }
        return undefined;
      },
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "20.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-write-failed");

    await user.click(screen.getByRole("button", { name: /accept/i }));
    await waitFor(() => expect(writesTo(fetchFn, "/costs").length).toBe(2));

    // Nothing landed on the first attempt, so the retry is the SAME bill —
    // idempotent by construction, never "the rest of" anything.
    const bodies = writesTo(fetchFn, "/costs").map((c) =>
      JSON.parse(String((c[1] as RequestInit).body)),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await screen.findByTestId("allocation-applied")).toBeInTheDocument();
  });

  it("a failure keeps the bill on screen and reports nothing as written", async () => {
    const user = userEvent.setup();
    renderDetail(
      detail({}, [line({ id: 11, countedQuantity: 10, unitCostCents: 500 })]),
      (url, init) => {
        if (url.includes("/costs") && init?.method === "POST") {
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
    await enterBill(user, "10.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByTestId("allocation-write-failed")).toBeInTheDocument();
    expect(screen.getByLabelText(/freight/i)).toHaveValue("10.00");
    // The partial-write report is GONE: there is no partial write to report.
    expect(screen.queryByTestId("cost-write-partial")).not.toBeInTheDocument();
    expect(within(lineRow(11)).getByTestId("line-cost")).toHaveTextContent("$5.00");
  });

  it("a CONFLICT (a line left the shipment) keeps the bill retriable, nothing written", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDetail(
      detail({}, [line({ id: 11, countedQuantity: 10, unitCostCents: 500 })]),
      (url, init) => {
        if (url.includes("/costs") && init?.method === "POST") {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error:
                "Staging item 11 changed state or left this shipment while the bill was being written; reload and retry",
              code: "CONFLICT",
            }),
          };
        }
        return undefined;
      },
    );

    await waitFor(() => expect(lineRow(11)).toBeInTheDocument());
    await enterBill(user, "10.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByTestId("allocation-write-failed")).toBeInTheDocument();
    // Not a drift: the bill still describes the costs on screen, so a retry is
    // legal (and would be refused again until the line comes back).
    expect(screen.queryByTestId("allocation-invalidated")).not.toBeInTheDocument();
    expect(writesTo(fetchFn, "/api/staging-items/")).toHaveLength(0);
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
