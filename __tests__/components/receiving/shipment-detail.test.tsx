/** @jest-environment jsdom */
/**
 * THE LEGACY RECEIPT, READ-ONLY (contract pack C4b.2, spec §9).
 *
 * W1's receiving detail was where boxes were counted, priced, graduated and
 * billed. The supply-order flow took every one of those acts, so what is left
 * here is HISTORY — and history's only job is to keep saying what it said when
 * it was recorded:
 *
 *   - an UNCOUNTED line is UNKNOWN, never "0 off";
 *   - an UNEXPECTED arrival (NULL expected) says so and counts in full;
 *   - an unpriced line is "Not priced", never $0.00 — and a genuine zero IS
 *     $0.00, because a free sample is a fact;
 *   - over and under never cancel out.
 *
 * The count / cost / close / cancel / link / freight / graduate cases that used
 * to live in this file are GONE with the affordances they covered, and the
 * load-error case moved to the screen that performs the read
 * (`receiving-detail-screen.test.tsx`). The last two pins hold the trim itself:
 * the component renders NO control at all, and it imports nothing from the
 * pre-staging surface that retires with it.
 */

import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { render, screen, within } from "@testing-library/react";

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

function renderDetail(data: Record<string, unknown> = detail()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<ShipmentDetail shipment={data as any} />);
}

const lineRow = (id: number) => screen.getByTestId(`receiving-line-${id}`);

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

describe("the header and its lines", () => {
  it("renders the header and every linked line", () => {
    renderDetail(detail({}, [line(), line({ id: 12, description: "Caps 500ct" })]));

    expect(within(screen.getByTestId("shipment-header")).getByText("PO-1001")).toBeInTheDocument();
    expect(screen.getByText("Vials 10ml")).toBeInTheDocument();
    expect(screen.getByText("Caps 500ct")).toBeInTheDocument();
    expect(screen.getByText(/opened by kris/)).toBeInTheDocument();
  });

  it("shows an uncounted line as UNCOUNTED, never as a match", () => {
    renderDetail();
    expect(within(lineRow(11)).getByTestId("line-flag")).toHaveTextContent("Not counted yet");
  });

  it("shows the signed delta on a counted line that missed", () => {
    renderDetail(
      detail({}, [
        line({
          countedQuantity: 7,
          flags: { counted: true, expectedMissing: false, delta: -3, direction: "UNDER" },
        }),
      ]),
    );
    expect(within(lineRow(11)).getByTestId("line-flag")).toHaveTextContent("3 under");
  });

  it("names an UNEXPECTED arrival (NULL expected counts in full)", () => {
    renderDetail(
      detail({}, [
        line({
          expectedQuantity: null,
          countedQuantity: 4,
          flags: { counted: true, expectedMissing: true, delta: 4, direction: "OVER" },
        }),
      ]),
    );
    expect(within(lineRow(11)).getByTestId("line-flag")).toHaveTextContent(
      "Unexpected arrival — 4 over",
    );
  });

  it("reports over and under separately, and says they never cancel", () => {
    renderDetail(
      detail({
        discrepancy: {
          itemCount: 2,
          countedItemCount: 2,
          uncountedItemCount: 0,
          discrepancyItemCount: 2,
          totalOver: 5,
          totalUnder: 3,
        },
      }),
    );
    const header = screen.getByTestId("shipment-header");
    expect(within(header).getByText("5")).toBeInTheDocument();
    expect(within(header).getByText("3")).toBeInTheDocument();
    expect(
      screen.getByText(/Over and under are reported separately and never cancel out/),
    ).toBeInTheDocument();
  });
});

describe("historical money", () => {
  it("renders an unpriced line as unknown, never as $0.00", () => {
    renderDetail();
    expect(within(lineRow(11)).getByTestId("line-cost")).toHaveTextContent("Not priced");
  });

  it("renders a genuine zero cost as $0.00 — a free sample is a fact", () => {
    renderDetail(detail({}, [line({ unitCostCents: 0 })]));
    expect(within(lineRow(11)).getByTestId("line-cost")).toHaveTextContent("$0.00");
  });
});

describe("settled receipts", () => {
  it("renders a CLOSED receipt's history", () => {
    renderDetail(
      detail({
        status: "CLOSED",
        closedAt: new Date().toISOString(),
        closedBy: 7,
      }),
    );
    expect(within(screen.getByTestId("shipment-header")).getByText("CLOSED")).toBeInTheDocument();
    expect(screen.getByText(/closed/)).toBeInTheDocument();
    expect(screen.getByText("Vials 10ml")).toBeInTheDocument();
  });

  it("renders a CANCELLED receipt's history", () => {
    renderDetail(detail({ status: "CANCELLED" }));
    expect(
      within(screen.getByTestId("shipment-header")).getByText("CANCELLED"),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The trim itself (M4b)
// ---------------------------------------------------------------------------

describe("read-only history", () => {
  it("carries the legacy banner and offers NO control whatsoever", () => {
    renderDetail(detail({}, [line(), line({ id: 12, description: "Caps 500ct" })]));

    expect(screen.getByTestId("legacy-banner")).toHaveTextContent(
      "Legacy receipt (read-only history)",
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByText(/save count/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/graduate/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/close shipment/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/add box/i)).not.toBeInTheDocument();
  });

  it("imports nothing from the pre-staging surface (the M4b import gate)", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/receiving/shipment-detail.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/@\/hooks\/use-staging/);
    expect(source).not.toMatch(/@\/components\/staging\//);
    expect(source).not.toMatch(/freight-calculator-panel/);
    // A pure PROP renderer: no fetch, no mutation, no CSRF token.
    expect(source).not.toMatch(/useMutation|useQuery|fetch\(/);
    expect(source).not.toMatch(/use-csrf/);
  });
});
