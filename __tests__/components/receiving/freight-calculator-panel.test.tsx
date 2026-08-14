/** @jest-environment jsdom */
/**
 * W1-4b — the freight calculator PANEL (pack REV-3 T3; W1-4a owns the maths).
 *
 * The panel's whole job is to put lib/shipments/cost-allocation.ts in front of
 * an operator without softening any of it:
 *
 *   - the REFUSAL is a rendered, named outcome — never a crash, never a
 *     fabricated split. "There is nothing to allocate against" is an answer;
 *   - the DISCLOSURES the module returns are shown, all of them;
 *   - the per-line ROUNDING DELTA is shown, because two identical lines that
 *     differ by a penny need an explanation on screen;
 *   - a NULL-cost line suggests NOTHING, with its reason — never $0.00;
 *   - EDITS are re-validated against the freight total, and Accept is held
 *     until they add up. The invariant survives the operator.
 *
 * Accept writes each line's `unitCostCents`; lines with no suggestible cost are
 * left alone rather than stamped with a number nobody chose.
 */

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FreightCalculatorPanel } from "@/components/receiving/freight-calculator-panel";

const LINES = [
  { id: 1, description: "Vials 10ml", qty: 10, qtySource: "counted" as const, baseCents: 500 },
  { id: 2, description: "Caps", qty: 5, qtySource: "counted" as const, baseCents: 200 },
];

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof FreightCalculatorPanel>> = {},
) {
  const onAccept = jest.fn();
  const utils = render(
    <FreightCalculatorPanel lines={LINES} onAccept={onAccept} {...overrides} />,
  );
  return { ...utils, onAccept };
}

const freightInput = () => screen.getByLabelText(/freight/i);
const lineRow = (id: number) => screen.getByTestId(`allocation-row-${id}`);
const allocationInput = (id: number) =>
  within(lineRow(id)).getByLabelText(/allocated/i);

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("allocation", () => {
  it("splits the freight by line VALUE and shows every allocation", async () => {
    const user = userEvent.setup();
    renderPanel();

    // Values are 10x500 = 5000 and 5x200 = 1000; 6000 of freight splits 5000/1000.
    await user.type(freightInput(), "60.00");

    expect(allocationInput(1)).toHaveValue(5000);
    expect(allocationInput(2)).toHaveValue(1000);
  });

  it("shows the module's disclosures verbatim", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(freightInput(), "60.00");

    expect(screen.getByTestId("allocation-disclosures")).toHaveTextContent(
      /allocated across 2 line\(s\) by line value/i,
    );
  });

  it("shows the per-line rounding residual rather than hiding it", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [
        { id: 1, description: "A", qty: 1, qtySource: "counted", baseCents: 1 },
        { id: 2, description: "B", qty: 1, qtySource: "counted", baseCents: 1 },
        { id: 3, description: "C", qty: 1, qtySource: "counted", baseCents: 1 },
      ],
    });

    // 10 cents over three equal lines: 3 + 3 + 3, one cent left over.
    await user.type(freightInput(), "0.10");

    const deltas = [1, 2, 3].map((id) =>
      within(lineRow(id)).getByTestId("rounding-delta").textContent,
    );
    expect(deltas.filter((d) => d === "+1")).toHaveLength(1);
    expect(screen.getByTestId("allocation-disclosures")).toHaveTextContent(
      /rounding residual/i,
    );
  });

  it("suggests base + allocated/qty per unit, and shows the unit remainder", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [{ id: 1, description: "A", qty: 3, qtySource: "counted", baseCents: 100 }],
    });

    // 10 cents across 3 units: 3 per unit, 1 cent no unit cost can express.
    await user.type(freightInput(), "0.10");

    expect(within(lineRow(1)).getByTestId("suggested-unit-cost")).toHaveTextContent(
      "$1.03",
    );
    expect(within(lineRow(1)).getByTestId("unit-remainder")).toHaveTextContent("1");
  });
});

// ---------------------------------------------------------------------------
// Truthful refusals and NULL costs
// ---------------------------------------------------------------------------

describe("refusal and unpriced lines", () => {
  it("RENDERS the refusal with its named reason instead of crashing", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [
        { id: 1, description: "A", qty: 4, qtySource: "counted", baseCents: null },
        { id: 2, description: "B", qty: 2, qtySource: "counted", baseCents: null },
      ],
    });

    await user.type(freightInput(), "60.00");

    const refusal = screen.getByTestId("allocation-refused");
    expect(refusal).toHaveTextContent(/zero_value_denominator/i);
    expect(refusal).toHaveTextContent(/cannot be allocated by value/i);
    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
  });

  it("holds Accept while the allocation is refused", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [{ id: 1, description: "A", qty: 4, qtySource: "counted", baseCents: null }],
    });

    await user.type(freightInput(), "60.00");

    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
  });

  it("suggests NOTHING for an unpriced line, with the reason — never $0.00", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [
        { id: 1, description: "Priced", qty: 10, qtySource: "counted", baseCents: 500 },
        { id: 2, description: "Unpriced", qty: 4, qtySource: "counted", baseCents: null },
      ],
    });

    await user.type(freightInput(), "60.00");

    const row = lineRow(2);
    expect(within(row).getByTestId("suggested-unit-cost")).not.toHaveTextContent(
      "$0.00",
    );
    expect(within(row).getByTestId("suggested-unit-cost")).toHaveTextContent(
      /no base cost/i,
    );
    expect(screen.getByTestId("allocation-disclosures")).toHaveTextContent(
      /have no base cost recorded/i,
    );
  });

  it("a freight bill of 0 is an ANSWER (every line 0), not a refusal", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(freightInput(), "0");

    expect(screen.queryByTestId("allocation-refused")).not.toBeInTheDocument();
    expect(allocationInput(1)).toHaveValue(0);
    expect(screen.getByTestId("allocation-disclosures")).toHaveTextContent(
      /No freight or fees were entered/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Edits are re-validated
// ---------------------------------------------------------------------------

describe("edited allocations", () => {
  it("re-validates an edit and names the mismatch", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(freightInput(), "60.00");
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "4000");

    const validation = screen.getByTestId("allocation-validation");
    expect(validation).toHaveTextContent(/total_mismatch/i);
    expect(validation).toHaveTextContent(/-1000/);
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
  });

  it("accepts an edit that still adds up to the freight total", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel();

    await user.type(freightInput(), "60.00");
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "4000");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "2000");

    expect(screen.getByTestId("allocation-validation")).toHaveTextContent(/add up/i);
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // Line 1: 500 + 4000/10 = 900. Line 2: 200 + 2000/5 = 600.
    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 900 },
      { id: 2, unitCostCents: 600 },
    ]);
  });

  it("Accept writes only the lines that HAVE a suggestible cost", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({
      lines: [
        { id: 1, description: "Priced", qty: 10, qtySource: "counted", baseCents: 500 },
        { id: 2, description: "Unpriced", qty: 4, qtySource: "counted", baseCents: null },
      ],
    });

    await user.type(freightInput(), "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([{ id: 1, unitCostCents: 1100 }]);
  });

  it("CLEARS the bill after Accept — the same freight must never land twice", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel();

    await user.type(freightInput(), "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // Accepting rewrote each base cost to base + freight. Leaving the bill in
    // the box would let a second Accept allocate it on top of itself.
    expect(freightInput()).toHaveValue("");
    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("allocation-applied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// W1S-3 (W1-C fix round) — a floored unit cost is never written by accident.
//
// `suggestedUnitCostCents` is base + FLOOR(allocated / qty). When the division
// is not exact the line's landed total is `qty * unit + remainder`, and writing
// the unit cost alone silently drops that remainder — real money, gone from the
// valuation with nobody told. The panel shows the remainder, but Accept used to
// write the line anyway. Now: exact lines write, inexact lines are WITHHELD, and
// the operator releases one either by editing the split until it is exact or by
// accepting the floored value explicitly, per line, with the drop named.
// ---------------------------------------------------------------------------

describe("inexact unit splits are withheld until somebody chooses (W1S-3)", () => {
  /**
   * Line 1 (qty 1) takes 2c and expresses it exactly. Line 2 (qty 3) takes 8c,
   * which is 2c per unit with 2c no unit cost can carry.
   */
  const MIXED = [
    { id: 1, description: "Exact", qty: 1, qtySource: "counted" as const, baseCents: 100 },
    { id: 2, description: "Inexact", qty: 3, qtySource: "counted" as const, baseCents: 100 },
  ];

  it("marks the inexact line as needing an exact split", async () => {
    const user = userEvent.setup();
    renderPanel({ lines: MIXED });

    await user.type(freightInput(), "0.10");

    expect(within(lineRow(2)).getByTestId("needs-exact-split")).toHaveTextContent(
      /exact split/i,
    );
    expect(within(lineRow(1)).queryByTestId("needs-exact-split")).not.toBeInTheDocument();
  });

  it("Accept writes ONLY the exact line, leaving the inexact one alone", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: MIXED });

    await user.type(freightInput(), "0.10");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([{ id: 1, unitCostCents: 102 }]);
  });

  it("holds Accept entirely when NO line can be written exactly", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [{ id: 1, description: "A", qty: 3, qtySource: "counted", baseCents: 100 }],
    });

    await user.type(freightInput(), "0.10");

    expect(within(lineRow(1)).getByTestId("needs-exact-split")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
  });

  it("an explicit per-line accept releases the floored cost AND names what it drops", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: MIXED });

    await user.type(freightInput(), "0.10");
    const release = within(lineRow(2)).getByRole("button", { name: /write floored/i });
    // The drop is named on the control itself, before it is pressed.
    expect(release).toHaveTextContent("2");
    await user.click(release);

    expect(within(lineRow(2)).getByTestId("floored-accepted")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 102 },
      { id: 2, unitCostCents: 102 },
    ]);
  });

  it("EDITING the split to something exact releases the line with no confirm at all", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: MIXED });

    await user.type(freightInput(), "0.10");
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "1");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "9");

    expect(screen.queryByTestId("needs-exact-split")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 101 },
      { id: 2, unitCostCents: 103 },
    ]);
  });

  it("says how many lines it is holding back", async () => {
    const user = userEvent.setup();
    renderPanel({ lines: MIXED });

    await user.type(freightInput(), "0.10");

    expect(screen.getByTestId("allocation-withheld")).toHaveTextContent(/1 line/i);
  });
});

// ---------------------------------------------------------------------------
// W1S-5 (W1-C fix round) — a failed write must not look like a clean one.
// ---------------------------------------------------------------------------

describe("a failing write keeps the bill (W1S-5)", () => {
  it("retains the freight total and the rows, and says the write failed", async () => {
    const user = userEvent.setup();
    const onAccept = jest.fn().mockRejectedValue(new Error("Failed to update the line"));
    render(<FreightCalculatorPanel lines={LINES} onAccept={onAccept} />);

    await user.type(freightInput(), "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByTestId("allocation-write-failed")).toHaveTextContent(
      /not written/i,
    );
    // The compounding guard must NOT fire: nothing was compounded.
    expect(freightInput()).toHaveValue("60.00");
    expect(screen.getByTestId("allocation-row-1")).toBeInTheDocument();
    expect(screen.queryByTestId("allocation-applied")).not.toBeInTheDocument();
  });

  it("clears the failure notice once a retry succeeds", async () => {
    const user = userEvent.setup();
    const onAccept = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    render(<FreightCalculatorPanel lines={LINES} onAccept={onAccept} />);

    await user.type(freightInput(), "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-write-failed");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByTestId("allocation-applied")).toBeInTheDocument();
    expect(screen.queryByTestId("allocation-write-failed")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Nothing to work with
// ---------------------------------------------------------------------------

describe("empty input", () => {
  it("says so when the shipment has no lines", () => {
    renderPanel({ lines: [] });
    expect(screen.getByTestId("allocation-empty")).toBeInTheDocument();
  });

  it("does not compute until a freight amount is entered", () => {
    renderPanel();
    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
  });

  it("refuses a negative freight amount without throwing", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(freightInput(), "-5");

    expect(screen.getByTestId("allocation-input-error")).toBeInTheDocument();
    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
  });
});
