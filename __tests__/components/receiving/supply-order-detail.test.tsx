/** @jest-environment jsdom */
/**
 * THE ORDER DETAIL (contract pack C4b.1, spec §4.2).
 *
 * One page for one order: what was ordered, what arrived, what was labeled, and
 * what still has to be followed up. The pins here are the places where a
 * plausible-looking screen would start telling the operator something untrue:
 *
 *   - THE CONTROLS FOLLOW THE LINE'S STATUS. An ORDERED line is verified; a
 *     VERIFIED line is adjusted and stocked. Offering a control the server will
 *     refuse teaches people to ignore refusals.
 *   - A TYPED 0 ASKS FIRST. "Nothing arrived for this line" is a real fact and
 *     stays recordable — the confirm is a typo guard, not a veto (G1s-15).
 *   - A 409 IS SHOWN VERBATIM. The server's sentence names the counters this
 *     attempt collided with; a sentence of the screen's own invention would be a
 *     guess about state the screen no longer has (C4b.4).
 *   - THE BATCH QUANTITY IS NEVER PRE-FILLED, through the shared row (S21).
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

import { SupplyOrderDetail } from "@/components/receiving/supply-order-detail";

const ORDER_ID = "cksupply000000000000000001";

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
  window.sessionStorage.clear();
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "booking-key-1" },
  });
  mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/locations")) {
      return jsonResponse(200, [
        { id: 1, name: "Main" },
        { id: 2, name: "Cold room" },
      ]);
    }
    return jsonResponse(200, {});
  });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function line(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    orderedProductId: 55,
    productId: 55,
    productName: "BPC-157 5mg",
    status: "ORDERED",
    orderedQuantity: 10,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    remaining: 0,
    lineTotalCents: 125000,
    unitCostCents: 12500,
    derivation: "$1,250.00 / 10 ordered = $125.00/unit",
    labelingRequired: true,
    locationId: null,
    verifiedAt: null,
    verifiedBy: null,
    discrepancy: null,
    exceptionKeys: [],
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}, lines = [line()]) {
  return {
    model: "supply-order",
    id: ORDER_ID,
    status: "ORDERED",
    supplier: "Acme Peptides",
    supplierRef: "PO-2026-0142",
    orderedAt: "2026-08-14T00:00:00.000Z",
    feesCents: 2500,
    feesNote: "freight",
    createdBy: 7,
    creator: { id: 7, username: "kris" },
    closedBy: null,
    closedAt: null,
    createdAt: "2026-08-14T09:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    notes: null,
    lineCounts: { ordered: lines.length, verified: 0, labeling: 0, complete: 0, discarded: 0 },
    units: { verified: 0, stocked: 0, disposed: 0 },
    discrepancy: {
      linesWithDiscrepancy: 0,
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unorderedLines: 0,
    },
    lines,
    exceptions: [],
    ...over,
  };
}

function renderDetail(data: Record<string, unknown> = detail()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <SupplyOrderDetail detail={data as any} />
    </QueryClientProvider>,
  );
}

const writes = () =>
  mockFetch.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method !== undefined,
  );
const bodyOf = (fragment: string) => {
  const call = writes().find(([url]) => String(url).includes(fragment));
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
};
const lineCard = (id: number) => screen.getByTestId(`supply-order-line-${id}`);

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

describe("the header", () => {
  it("shows the order's identity, its money and who opened it", () => {
    renderDetail();
    expect(screen.getByText("PO-2026-0142")).toBeInTheDocument();
    expect(screen.getByText(/Acme Peptides/)).toBeInTheDocument();
    // The ordered DAY, in UTC — never shifted into the reader's timezone.
    expect(screen.getByText(/2026-08-14/)).toBeInTheDocument();
    expect(screen.getByText(/\$25\.00/)).toBeInTheDocument();
    expect(screen.getByText(/kris/)).toBeInTheDocument();
  });

  it("offers Cancel while ORDERED and no Close (nothing is verified yet)", () => {
    renderDetail();
    expect(screen.getByRole("button", { name: /cancel order/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close order/i })).not.toBeInTheDocument();
  });

  it("offers Close once the order is RECEIVING, and no Cancel", () => {
    renderDetail(detail({ status: "RECEIVING" }));
    expect(screen.getByRole("button", { name: /close order/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel order/i })).not.toBeInTheDocument();
  });

  it("links to the labeling queue for THIS order while units remain", () => {
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "VERIFIED", verifiedQuantity: 10, remaining: 10 }),
      ]),
    );
    expect(screen.getByRole("link", { name: /label now/i })).toHaveAttribute(
      "href",
      `/labeling?orderId=${ORDER_ID}`,
    );
  });

  it("offers no Label now when nothing is left to label", () => {
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "COMPLETE", verifiedQuantity: 10, stockedQuantity: 10, remaining: 0 }),
      ]),
    );
    expect(screen.queryByRole("link", { name: /label now/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Controls by status
// ---------------------------------------------------------------------------

describe("the controls follow the line's status", () => {
  it("an ORDERED line offers the verify controls and no batch row", () => {
    renderDetail();
    const card = lineCard(11);
    expect(within(card).getByRole("button", { name: /counted 10 — matches order/i })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /enter discrepancy/i })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /different product arrived/i })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /remove line/i })).toBeInTheDocument();
    expect(screen.queryByTestId("batch-row-11")).not.toBeInTheDocument();
  });

  it("a VERIFIED line with units left offers Adjust count and the batch row", () => {
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "VERIFIED", verifiedQuantity: 10, remaining: 10 }),
      ]),
    );
    const card = lineCard(11);
    expect(within(card).getByRole("button", { name: /adjust count/i })).toBeInTheDocument();
    expect(screen.getByTestId("batch-row-11")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /counted 10 — matches order/i })).toBeNull();
  });

  it("a COMPLETE line offers no batch row — there is nothing left to book", () => {
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "COMPLETE", verifiedQuantity: 10, stockedQuantity: 10, remaining: 0 }),
      ]),
    );
    expect(screen.queryByTestId("batch-row-11")).not.toBeInTheDocument();
  });

  it("NEVER pre-fills the batch quantity from what remains (S21, through the shared row)", () => {
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "VERIFIED", verifiedQuantity: 10, remaining: 10 }),
      ]),
    );
    const quantity = within(screen.getByTestId("batch-row-11")).getByLabelText(
      /quantity/i,
    ) as HTMLInputElement;
    expect(quantity.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe("verifying a line", () => {
  it("'Counted N — matches order' posts the ORDERED quantity", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("button", { name: /counted 10 — matches order/i }));

    await waitFor(() => expect(bodyOf("/verify")).not.toBeNull());
    expect(bodyOf("/verify")).toEqual({ verifiedQuantity: 10 });
  });

  it("a typed discrepancy posts the typed count and the note", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("button", { name: /enter discrepancy/i }));
    await user.type(screen.getByLabelText(/counted units/i), "7");
    await user.type(screen.getByLabelText(/note/i), "one box short");
    await user.click(screen.getByRole("button", { name: /^record count$/i }));

    await waitFor(() => expect(bodyOf("/verify")).not.toBeNull());
    expect(bodyOf("/verify")).toEqual({ verifiedQuantity: 7, note: "one box short" });
  });

  it("a typed 0 ASKS FIRST — and records the fact once confirmed", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    renderDetail();

    await user.click(screen.getByRole("button", { name: /enter discrepancy/i }));
    await user.type(screen.getByLabelText(/counted units/i), "0");
    await user.click(screen.getByRole("button", { name: /^record count$/i }));

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("Nothing arrived for this line"),
    );
    await waitFor(() => expect(bodyOf("/verify")).toEqual({ verifiedQuantity: 0 }));
    confirmSpy.mockRestore();
  });

  it("a declined 0 confirm writes nothing", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    renderDetail();

    await user.click(screen.getByRole("button", { name: /enter discrepancy/i }));
    await user.type(screen.getByLabelText(/counted units/i), "0");
    await user.click(screen.getByRole("button", { name: /^record count$/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(writes().filter(([url]) => String(url).includes("/verify"))).toHaveLength(0);
    confirmSpy.mockRestore();
  });

  it("moves the labeling flag by PATCH while the line is ORDERED", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("button", { name: /edit line/i }));
    await user.click(screen.getByRole("checkbox", { name: /labeling required/i }));
    await user.click(screen.getByRole("button", { name: /^save line$/i }));

    await waitFor(() => expect(bodyOf("/lines/11")).not.toBeNull());
    expect(bodyOf("/lines/11")).toEqual({ labelingRequired: false });
  });

  it("moves the labeling flag through VERIFY once the line is verified", async () => {
    const user = userEvent.setup();
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "VERIFIED", verifiedQuantity: 10, remaining: 10 }),
      ]),
    );

    await user.click(screen.getByRole("button", { name: /skip labeling/i }));

    await waitFor(() => expect(bodyOf("/verify")).not.toBeNull());
    expect(bodyOf("/verify")).toEqual({ verifiedQuantity: 10, labelingRequired: false });
  });

  it("offers no labeling re-tag on a COMPLETE line — a lower would always refuse", () => {
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "COMPLETE", verifiedQuantity: 10, stockedQuantity: 10, remaining: 0 }),
      ]),
    );
    expect(screen.queryByRole("button", { name: /skip labeling/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /require labeling/i })).not.toBeInTheDocument();
  });

  it("a substitution re-maps the line through deliveredProduct", async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/api/products/optimized")) {
        return jsonResponse(200, {
          products: [
            { id: 99, name: "TB-500 5mg", approvalStatus: "APPROVED", createdBy: 7 },
          ],
        });
      }
      return jsonResponse(200, {});
    });
    renderDetail();

    await user.click(screen.getByRole("button", { name: /different product arrived/i }));
    expect(
      screen.getByText(/a substitution re-maps this line/i),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /TB-500 5mg/ }));
    await user.type(screen.getByLabelText(/counted units/i), "10");
    await user.click(screen.getByRole("button", { name: /^record count$/i }));

    await waitFor(() => expect(bodyOf("/verify")).not.toBeNull());
    expect(bodyOf("/verify")).toEqual({
      verifiedQuantity: 10,
      deliveredProduct: { mode: "existing", productId: 99 },
    });
  });
});

// ---------------------------------------------------------------------------
// The 409 UX (C4b.4)
// ---------------------------------------------------------------------------

describe("a refusal", () => {
  it("shows a blocked CLOSE verbatim and names the lines that blocked it", async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes(`/api/inbound-shipments/${ORDER_ID}`)) {
        return jsonResponse(409, {
          error:
            "The order still has unverified lines (11); verify or discard them before closing",
          code: "UNVERIFIED",
          lineIds: [11],
        });
      }
      return jsonResponse(200, {});
    });
    renderDetail(detail({ status: "RECEIVING" }));

    await user.click(screen.getByRole("button", { name: /close order/i }));

    expect(
      await screen.findByText(
        "The order still has unverified lines (11); verify or discard them before closing",
      ),
    ).toBeInTheDocument();
    expect(lineCard(11)).toHaveAttribute("data-blocked", "true");
  });

  it("shows a VERIFIED_LOCKED adjust refusal verbatim, and never resubmits", async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/verify")) {
        return jsonResponse(409, {
          error:
            "The verified count is locked: 6 unit(s) stocked and 1 disposed against this line already",
          code: "VERIFIED_LOCKED",
          stocked: 6,
          disposed: 1,
        });
      }
      return jsonResponse(200, {});
    });
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({ status: "LABELING", verifiedQuantity: 10, stockedQuantity: 6, disposedQuantity: 1, remaining: 3 }),
      ]),
    );

    await user.click(screen.getByRole("button", { name: /adjust count/i }));
    await user.type(screen.getByLabelText(/counted units/i), "4");
    await user.click(screen.getByRole("button", { name: /^record count$/i }));

    expect(
      await screen.findByText(
        "The verified count is locked: 6 unit(s) stocked and 1 disposed against this line already",
      ),
    ).toBeInTheDocument();
    expect(writes().filter(([url]) => String(url).includes("/verify"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unordered arrivals
// ---------------------------------------------------------------------------

describe("add arrived line", () => {
  it("is offered while RECEIVING and posts the unordered arrival", async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/api/products/optimized")) {
        return jsonResponse(200, {
          products: [{ id: 99, name: "TB-500 5mg", approvalStatus: "APPROVED", createdBy: 7 }],
        });
      }
      return jsonResponse(200, {});
    });
    renderDetail(detail({ status: "RECEIVING" }));

    await user.click(screen.getByRole("button", { name: /add arrived line/i }));
    const panel = screen.getByTestId("add-arrived-line");
    expect(
      within(panel).getByText(/only for a product that was NOT on the order/i),
    ).toBeInTheDocument();

    await user.click(await within(panel).findByRole("button", { name: /TB-500 5mg/ }));
    await user.type(within(panel).getByLabelText(/counted units/i), "6");
    await user.click(within(panel).getByRole("button", { name: /^add line$/i }));

    await waitFor(() => expect(bodyOf("/lines")).not.toBeNull());
    expect(bodyOf("/lines")).toEqual({
      product: { mode: "existing", productId: 99 },
      verifiedQuantity: 6,
      labelingRequired: true,
    });
  });

  it("is NOT offered while the order is only ORDERED", () => {
    renderDetail();
    expect(screen.queryByRole("button", { name: /add arrived line/i })).not.toBeInTheDocument();
  });

  it("tags an unordered line and never calls it over", () => {
    renderDetail(
      detail({ status: "RECEIVING" }, [
        line({
          status: "VERIFIED",
          orderedProductId: null,
          orderedQuantity: null,
          verifiedQuantity: 6,
          remaining: 6,
          discrepancy: {
            shortUnits: 0,
            overUnits: 0,
            lossCents: 0,
            surplusValueCents: 0,
            unordered: true,
          },
        }),
      ]),
    );
    const card = lineCard(11);
    expect(within(card).getByText(/unordered arrival/i)).toBeInTheDocument();
    expect(within(card).queryByText(/over/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

describe("the follow-up panel", () => {
  const shortage = {
    key: "recv-discrepancy:11",
    kind: "recv-discrepancy",
    subject: { lineId: 11, shortUnits: 3, lossCents: 37500, surplusValueCents: 0 },
    firstSeenAt: "2026-08-15T09:00:00.000Z",
    lastSeenAt: "2026-08-15T09:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    note: null,
    lineId: 11,
  };

  it("lists the order's exceptions with their money", () => {
    renderDetail(detail({ status: "RECEIVING", exceptions: [shortage] }));
    const panel = screen.getByTestId("follow-up-panel");
    expect(within(panel).getByText(/recv-discrepancy/)).toBeInTheDocument();
    expect(within(panel).getByText(/\$375\.00/)).toBeInTheDocument();
    expect(within(panel).getByText(/open/i)).toBeInTheDocument();
  });

  it("resolves with the chosen resolution and its evidence", async () => {
    const user = userEvent.setup();
    renderDetail(detail({ status: "RECEIVING", exceptions: [shortage] }));

    await user.click(screen.getByRole("button", { name: /^resolve$/i }));
    await user.click(screen.getByRole("combobox", { name: /resolution/i }));
    await user.click(await screen.findByRole("option", { name: /supplier-credited/ }));
    await user.type(screen.getByLabelText(/credit reference/i), "CR-42");
    await user.type(screen.getByLabelText(/note/i), "credited in full");
    await user.click(screen.getByRole("button", { name: /^settle$/i }));

    await waitFor(() => expect(bodyOf("/resolve")).not.toBeNull());
    expect(bodyOf("/resolve")).toEqual({
      exceptionKey: "recv-discrepancy:11",
      resolution: "supplier-credited",
      note: "credited in full",
      creditRef: "CR-42",
    });
    expect(String(writes().find(([url]) => String(url).includes("/resolve"))?.[0])).toContain(
      `/api/inbound-shipments/${ORDER_ID}/lines/11/resolve`,
    );
  });

  it("keeps a RESOLVED row listed and says how it was settled", () => {
    renderDetail(
      detail({
        status: "RECEIVING",
        exceptions: [
          {
            ...shortage,
            resolvedAt: "2026-08-16T09:00:00.000Z",
            resolvedBy: 7,
            resolution: "accepted-loss",
            note: "written off",
          },
        ],
      }),
    );
    const panel = screen.getByTestId("follow-up-panel");
    expect(within(panel).getByText(/accepted-loss/)).toBeInTheDocument();
    expect(within(panel).getByText(/written off/)).toBeInTheDocument();
  });

  it("carries the boundary sentence on a labeling-loss row", () => {
    renderDetail(
      detail({
        status: "RECEIVING",
        exceptions: [
          {
            ...shortage,
            key: "labeling-loss:11",
            kind: "labeling-loss",
            subject: { lineId: 11, units: 2, lossCents: 2500, reason: "dropped" },
          },
        ],
      }),
    );
    expect(
      screen.getByText(
        /before stock-in a loss is a labeling loss; after stock-in it is an inventory adjustment \(DAMAGE\) on the product/i,
      ),
    ).toBeInTheDocument();
  });

  it("says so when there is nothing to follow up", () => {
    renderDetail(detail({ status: "RECEIVING" }));
    expect(
      screen.getByText(/nothing to follow up — discrepancies and labeling losses land here/i),
    ).toBeInTheDocument();
  });
});
