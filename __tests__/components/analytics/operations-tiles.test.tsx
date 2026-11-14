/** @jest-environment jsdom */
/**
 * THE OPERATIONS SUMMARY TILES — the "Shrinkage (90 days)" caption (FR1 of the
 * spot count, row 128 (5)).
 *
 * The tile's figure is `getShrinkageSummary`'s, whose read is ADJUSTMENT and
 * CORRECTION rows only. A shortfall found with Adjust stock's Count is booked
 * as a COUNT ledger row, so it never lands in that figure — the caption must
 * not name "count" as a loss class on its own, and it says where those counts
 * are NOT. Both branches are pinned byte for byte, with the caption's title.
 *
 * FR2 (row 130 (4)): an API caller can still write ADJUSTMENT rows coded COUNT
 * through `batch-adjust`, so the no-unclassified branch no longer calls them
 * "older" — it names them as adjustments coded as counts.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";

import { OperationsTiles, type OperationsTilesData } from "@/components/analytics/operations-tiles";

function bucket() {
  return { units: 0, valueAtCurrentCostCents: null, costCoverage: { costedUnits: 0, totalUnits: 0 } };
}

function data(over: { unclassified: number; totalUnits?: number; valueCents?: number | null }): OperationsTilesData {
  return {
    rows: [],
    shrinkage90: {
      byReason: { DAMAGE: bucket(), THEFT: bucket(), EXPIRY: bucket(), COUNT: bucket() },
      totalUnits: over.totalUnits ?? 12,
      totalValueAtCurrentCostCents: over.valueCents === undefined ? 4500 : over.valueCents,
      costCoverage: { costedUnits: 12, totalUnits: 12 },
      coverage: { unclassifiedOutboundUnits: over.unclassified, reasonTrackingStartedAt: null },
    },
    valuation: {
      atCurrentCostCents: null,
      costCoverage: { valued: 0, of: 0 },
      atReceiptCostCents: null,
      receiptCoverage: { have: 0, of: 0 },
    },
  } as unknown as OperationsTilesData;
}

/** The shrinkage tile's caption element (the line under its figure). */
function shrinkageCaption(): HTMLElement {
  const label = screen.getByText("Shrinkage (90 days)");
  const tile = label.parentElement as HTMLElement;
  const caption = tile.children[2] as HTMLElement | undefined;
  expect(caption).toBeDefined();
  return caption as HTMLElement;
}

const CAPTION_TITLE =
  "A shortfall found with Adjust stock's Count is recorded as a count movement, not as loss, so it is not in this figure.";

describe("the Shrinkage (90 days) tile's caption (row 128 (5))", () => {
  it("with unclassified outbound: classified loss only, the unclassified units, and the Adjust stock counts excluded — byte for byte", () => {
    render(<OperationsTiles data={data({ unclassified: 16234 })} />);
    expect(shrinkageCaption().textContent).toBe(
      "$45.00 · classified loss only. 16,234 outbound units carry no reason code and are not counted as loss. Counts from Adjust stock are not counted here.",
    );
  });

  it("with none: damage, theft, expiry and ADJUSTMENTS CODED AS COUNTS (never \"older\"), and the Adjust stock counts excluded — byte for byte (row 130 (4))", () => {
    render(<OperationsTiles data={data({ unclassified: 0 })} />);
    expect(shrinkageCaption().textContent).toBe(
      "$45.00 · damage, theft, expiry and adjustments coded as counts. Counts from Adjust stock are not counted here.",
    );
    expect(shrinkageCaption().textContent).not.toMatch(/\bolder\b/);
  });

  it("no cost on file keeps the money truthful in both branches (`No cost data`, never $0.00)", () => {
    render(<OperationsTiles data={data({ unclassified: 0, valueCents: null })} />);
    expect(shrinkageCaption().textContent).toBe(
      "No cost data · damage, theft, expiry and adjustments coded as counts. Counts from Adjust stock are not counted here.",
    );
  });

  it.each([
    ["with unclassified outbound", 7],
    ["with none", 0],
  ])("the caption's title says where a dialog count goes (%s)", (_label, unclassified) => {
    render(<OperationsTiles data={data({ unclassified })} />);
    expect(shrinkageCaption()).toHaveAttribute("title", CAPTION_TITLE);
  });

  it.each([
    ["with unclassified outbound", 7],
    ["with none", 0],
  ])("\"count\" is never named as a loss class by itself (%s)", (_label, unclassified) => {
    render(<OperationsTiles data={data({ unclassified })} />);
    const caption = shrinkageCaption().textContent ?? "";
    // The old list ended "damage, theft, expiry, count" — a dialog count is not a loss.
    expect(caption).not.toMatch(/expiry, count\b/);
    expect(caption).not.toMatch(/,\s*count\b/);
    expect(caption).toContain("Counts from Adjust stock are not counted here.");
  });
});
