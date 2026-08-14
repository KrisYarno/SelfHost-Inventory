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

/**
 * Type a bill and FREEZE it (FD-1). Allocate is the session's start: everything
 * below it is computed from the base costs as they were at that moment, never
 * from a row that refreshed underneath the operator.
 */
async function enterBill(user: ReturnType<typeof userEvent.setup>, dollars: string) {
  await user.type(freightInput(), dollars);
  await user.click(screen.getByRole("button", { name: /allocate/i }));
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("allocation", () => {
  it("splits the freight by line VALUE and shows every allocation", async () => {
    const user = userEvent.setup();
    renderPanel();

    // Values are 10x500 = 5000 and 5x200 = 1000; 6000 of freight splits 5000/1000.
    await enterBill(user, "60.00");

    expect(allocationInput(1)).toHaveValue(5000);
    expect(allocationInput(2)).toHaveValue(1000);
  });

  it("shows the module's disclosures verbatim", async () => {
    const user = userEvent.setup();
    renderPanel();

    await enterBill(user, "60.00");

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
    await enterBill(user, "0.10");

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
    await enterBill(user, "0.10");

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

    await enterBill(user, "60.00");

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

    await enterBill(user, "60.00");

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

    await enterBill(user, "60.00");

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

    await enterBill(user, "0");

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

    await enterBill(user, "60.00");
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

    await enterBill(user, "60.00");
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "4000");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "2000");

    expect(screen.getByTestId("allocation-validation")).toHaveTextContent(/add up/i);
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // Line 1: 500 + 4000/10 = 900. Line 2: 200 + 2000/5 = 600. Each carries the
    // FROZEN base as its server-side precondition (FD2-2).
    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 900, ifUnitCostCents: 500 },
      { id: 2, unitCostCents: 600, ifUnitCostCents: 200 },
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

    await enterBill(user, "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 1100, ifUnitCostCents: 500 },
    ]);
  });

  it("CLEARS the bill after Accept — the same freight must never land twice", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel();

    await enterBill(user, "60.00");
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

    await enterBill(user, "0.10");

    expect(within(lineRow(2)).getByTestId("needs-exact-split")).toHaveTextContent(
      /exact split/i,
    );
    expect(within(lineRow(1)).queryByTestId("needs-exact-split")).not.toBeInTheDocument();
  });

  it("Accept writes ONLY the exact line, leaving the inexact one alone", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: MIXED });

    await enterBill(user, "0.10");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 102, ifUnitCostCents: 100 },
    ]);
  });

  it("holds Accept entirely when NO line can be written exactly", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [{ id: 1, description: "A", qty: 3, qtySource: "counted", baseCents: 100 }],
    });

    await enterBill(user, "0.10");

    expect(within(lineRow(1)).getByTestId("needs-exact-split")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
  });

  it("an explicit per-line accept releases the floored cost AND names what it drops", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: MIXED });

    await enterBill(user, "0.10");
    const release = within(lineRow(2)).getByRole("button", { name: /write floored/i });
    // The drop is named on the control itself, before it is pressed.
    expect(release).toHaveTextContent("2");
    await user.click(release);

    expect(within(lineRow(2)).getByTestId("floored-accepted")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 102, ifUnitCostCents: 100 },
      { id: 2, unitCostCents: 102, ifUnitCostCents: 100 },
    ]);
  });

  it("EDITING the split to something exact releases the line with no confirm at all", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: MIXED });

    await enterBill(user, "0.10");
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "1");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "9");

    expect(screen.queryByTestId("needs-exact-split")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 101, ifUnitCostCents: 100 },
      { id: 2, unitCostCents: 103, ifUnitCostCents: 100 },
    ]);
  });

  it("says how many lines it is holding back", async () => {
    const user = userEvent.setup();
    renderPanel({ lines: MIXED });

    await enterBill(user, "0.10");

    expect(screen.getByTestId("allocation-withheld")).toHaveTextContent(/1 line/i);
    // There IS a rest to write here, so saying so is true.
    expect(screen.getByTestId("allocation-withheld")).toHaveTextContent(/writes the rest/i);
  });

  it("QA-12a: does NOT promise to write 'the rest' when there is no rest", async () => {
    const user = userEvent.setup();
    renderPanel({
      lines: [{ id: 1, description: "A", qty: 3, qtySource: "counted", baseCents: 100 }],
    });

    await enterBill(user, "0.10");

    // Every line is held back and Accept is disabled: "Accept writes the rest"
    // describes a button that cannot be pressed and a rest that does not exist.
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
    const withheld = screen.getByTestId("allocation-withheld");
    expect(withheld).not.toHaveTextContent(/writes the rest/i);
    expect(withheld).toHaveTextContent(/all 1 line/i);
  });
});

// ---------------------------------------------------------------------------
// QA-12b — a write that changes nothing is not a write
// ---------------------------------------------------------------------------
//
// A qty-0 line takes a 0 allocation (it has no value to allocate against), so
// its "suggested" unit cost is its own base cost. Sending it meant a row lock,
// an updatedAt bump and a precondition to lose the race on, all to store the
// number already there.

describe("no-op lines never reach the payload (QA-12b)", () => {
  const WITH_ZERO_QTY = [
    { id: 1, description: "Vials", qty: 10, qtySource: "counted" as const, baseCents: 500 },
    // Logged but never counted and nothing expected: qty 0, priced 200c.
    { id: 2, description: "Mystery box", qty: 0, qtySource: "none" as const, baseCents: 200 },
  ];

  it("leaves a qty-0 line out of the bill entirely", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: WITH_ZERO_QTY });

    await enterBill(user, "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 1100, ifUnitCostCents: 500 },
    ]);
  });

  it("still writes a 0-allocation line whose cost the operator EDITED upward", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: WITH_ZERO_QTY });

    await enterBill(user, "60.00");
    // Hand the mystery box some of the freight; the totals must still add up.
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "5990");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "10");

    // qty 0 cannot express a per-unit share, so this line is now withheld
    // (1c nothing can carry) rather than silently written at its old cost.
    expect(within(lineRow(2)).getByTestId("needs-exact-split")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /accept/i }));
    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 1099, ifUnitCostCents: 500 },
    ]);
  });

  it("a bill of nothing has nothing to write, and Accept says so by staying disabled", async () => {
    const user = userEvent.setup();
    renderPanel();

    await enterBill(user, "0");

    // Every line is allocated 0 and would be restated at its own base cost.
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
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

    await enterBill(user, "60.00");
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

    await enterBill(user, "60.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-write-failed");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByTestId("allocation-applied")).toBeInTheDocument();
    expect(screen.queryByTestId("allocation-write-failed")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// FD-1 (fix round 2) — THE BILL SESSION.
//
// W1S-5 kept the bill on screen after a partial write, but the panel's INPUTS
// are the shipment's live rows, and every successful PATCH invalidated that
// query. So the retry recomputed against the lines it had just written: a line
// that went 100c -> 200c came back as a 200c BASE, the same freight was split
// again over the new values, and Accept re-sent it at 333c. The guard against
// entering the same bill twice did nothing about entering it once and having it
// applied twice.
//
// The bill is a SESSION: Allocate freezes the base costs it was computed from,
// nothing recomputes mid-session, and a row that moves underneath an open bill
// invalidates the whole thing by name rather than quietly re-basing it.
//
// FD3-1 (fix round 4) removed the OTHER half of that fix — the partial-write
// bookkeeping. The caller now writes the whole bill in one transaction, so
// "which lines wrote" is no longer a question with an answer: either all of
// them did, or none did.
// ---------------------------------------------------------------------------

describe("the bill session (FD-1)", () => {
  /** Two 100c lines of one unit each: 200c of freight lands 100c on each. */
  const PAIR = [
    { id: 1, description: "A", qty: 1, qtySource: "counted" as const, baseCents: 100 },
    { id: 2, description: "B", qty: 1, qtySource: "counted" as const, baseCents: 100 },
  ];

  it("PIN 6: Accept-again after a failure re-sends the IDENTICAL full bill", async () => {
    const user = userEvent.setup();
    const onAccept = jest
      .fn()
      .mockRejectedValueOnce(new Error("Database is unavailable"))
      .mockResolvedValueOnce(undefined);
    render(<FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-write-failed");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // Nothing landed, so the retry is the SAME request — a legal full retry, not
    // a "retry of the rest" that has to be reasoned about.
    const bill = [
      { id: 1, unitCostCents: 200, ifUnitCostCents: 100 },
      { id: 2, unitCostCents: 200, ifUnitCostCents: 100 },
    ];
    expect(onAccept).toHaveBeenNthCalledWith(1, bill);
    expect(onAccept).toHaveBeenNthCalledWith(2, bill);
    // 333 is the number the compounding panel would have re-sent for line 1.
    expect(JSON.stringify(onAccept.mock.calls)).not.toContain("333");
  });

  it("PIN 8: NO partial-write state is reachable, even from a legacy-shaped rejection", async () => {
    const user = userEvent.setup();
    // The dead S12 seam, deliberately still on the error: a caller that reports
    // "line 1 landed" is now WRONG (the write is one transaction), and the panel
    // must not act on it at all.
    const onAccept = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Database is unavailable"), { writtenLineIds: [1] }),
      );
    render(<FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-write-failed");

    // No "already written" badge, no locked total, no disabled allocation input:
    // every state the fan-out needed is gone because the failure mode is gone.
    expect(screen.queryByTestId("line-written")).not.toBeInTheDocument();
    expect(freightInput()).not.toHaveAttribute("readonly");
    expect(allocationInput(1)).toBeEnabled();
    expect(allocationInput(2)).toBeEnabled();
    expect(screen.getByRole("button", { name: /accept/i })).toBeEnabled();

    // ...and the retry is still the WHOLE bill, line 1 included.
    await user.click(screen.getByRole("button", { name: /accept/i }));
    expect(onAccept).toHaveBeenLastCalledWith([
      { id: 1, unitCostCents: 200, ifUnitCostCents: 100 },
      { id: 2, unitCostCents: 200, ifUnitCostCents: 100 },
    ]);
  });

  it("INVALIDATES the whole bill by name when a line's cost moves underneath it", async () => {
    const user = userEvent.setup();
    const onAccept = jest.fn();
    const { rerender } = render(
      <FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />,
    );

    await enterBill(user, "2.00");
    expect(screen.getByTestId("allocation-row-1")).toBeInTheDocument();

    // Somebody priced a line on the shipment while this bill was open.
    rerender(
      <FreightCalculatorPanel
        lines={[{ ...PAIR[0], baseCents: 750 }, PAIR[1]]}
        onAccept={onAccept}
      />,
    );

    expect(screen.getByTestId("allocation-invalidated")).toHaveTextContent(
      /re-enter the bill/i,
    );
    // Nothing is computed from a stale base, and nothing can be accepted.
    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /allocate/i })).toBeDisabled();
  });

  it("invalidates when a line LEAVES the shipment mid-bill", async () => {
    const user = userEvent.setup();
    const onAccept = jest.fn();
    const { rerender } = render(
      <FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />,
    );

    await enterBill(user, "2.00");
    rerender(<FreightCalculatorPanel lines={[PAIR[0]]} onAccept={onAccept} />);

    expect(screen.getByTestId("allocation-invalidated")).toBeInTheDocument();
  });

  it("clearing an invalidated bill starts from nothing (never re-allocates the same freight)", async () => {
    const user = userEvent.setup();
    const onAccept = jest.fn();
    const { rerender } = render(
      <FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />,
    );

    await enterBill(user, "2.00");
    rerender(
      <FreightCalculatorPanel
        lines={[{ ...PAIR[0], baseCents: 750 }, PAIR[1]]}
        onAccept={onAccept}
      />,
    );
    await user.click(screen.getByRole("button", { name: /clear the bill/i }));

    expect(screen.queryByTestId("allocation-invalidated")).not.toBeInTheDocument();
    expect(freightInput()).toHaveValue("");
    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
  });

  it("does not compute until Allocate freezes the bill", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(freightInput(), "60.00");

    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
  });

  it("editing the freight total drops the frozen bill (it is a different bill)", async () => {
    const user = userEvent.setup();
    renderPanel();

    await enterBill(user, "60.00");
    await user.type(freightInput(), "1");

    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// FD-4 (fix round 2) — floored consent is keyed to the AMOUNTS it was given for.
//
// `flooredAccepted[lineId] = true` outlived the edit that changed what the line
// would drop: an operator who agreed to lose 2c could be silently held to have
// agreed to lose 3c. The consent now carries the floored unit cost AND the
// remainder it was given for, and an edit that changes either one takes the
// line straight back to withheld — with the new amount named on the control.
// ---------------------------------------------------------------------------

describe("floored consent is keyed to the amounts (FD-4)", () => {
  /** qty 4 makes line 2's remainder move with the allocation: 10c -> 2, 11c -> 3. */
  const CONSENT_LINES = [
    { id: 1, description: "Exact", qty: 1, qtySource: "counted" as const, baseCents: 100 },
    { id: 2, description: "Inexact", qty: 4, qtySource: "counted" as const, baseCents: 100 },
  ];

  it("consent given at drops-2c does NOT authorize drops-3c after an edit", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: CONSENT_LINES });

    // 13c splits 3 / 10; line 2 floors to 102 with 2c it cannot express.
    await enterBill(user, "0.13");
    const release = within(lineRow(2)).getByRole("button", { name: /write floored/i });
    expect(release).toHaveTextContent("2");
    await user.click(release);
    expect(within(lineRow(2)).getByTestId("floored-accepted")).toHaveTextContent("2");

    // Re-splitting the same total moves the drop to 3c — a different bargain.
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "2");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "11");

    expect(within(lineRow(2)).queryByTestId("floored-accepted")).not.toBeInTheDocument();
    expect(within(lineRow(2)).getByTestId("needs-exact-split")).toBeInTheDocument();
    expect(
      within(lineRow(2)).getByRole("button", { name: /write floored/i }),
    ).toHaveTextContent("3");

    await user.click(screen.getByRole("button", { name: /accept/i }));
    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 102, ifUnitCostCents: 100 },
    ]);
  });

  it("re-consenting at the new amount releases the line again", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({ lines: CONSENT_LINES });

    await enterBill(user, "0.13");
    await user.click(within(lineRow(2)).getByRole("button", { name: /write floored/i }));
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "2");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "11");
    await user.click(within(lineRow(2)).getByRole("button", { name: /write floored/i }));

    expect(within(lineRow(2)).getByTestId("floored-accepted")).toHaveTextContent("3");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // 100 + floor(11/4) = 102, the 3c named above deliberately dropped.
    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 102, ifUnitCostCents: 100 },
      { id: 2, unitCostCents: 102, ifUnitCostCents: 100 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// FD2-2 (fix round 3) — the drift check is the SERVER's.
//
// Everything the panel compares is a render old, so any foreign change to a line
// between the freeze and the write would simply be overwritten. Every line of
// the bill therefore carries the value it EXPECTS the row to hold, the server
// makes that the WHERE, and a refusal (409 COST_DRIFT on the house envelope)
// invalidates the whole bill.
//
// FD3-1 (fix round 4): the refusal now arrives as the API error's `code` — the
// same field the server sent — rather than through a bespoke seam field on a
// partial-write error class. That class is gone with the fan-out it described.
// ---------------------------------------------------------------------------

describe("the write carries its own precondition (FD2-2)", () => {
  const PAIR = [
    { id: 1, description: "A", qty: 1, qtySource: "counted" as const, baseCents: 100 },
    { id: 2, description: "B", qty: 1, qtySource: "counted" as const, baseCents: 100 },
  ];

  it("sends the FROZEN base as the precondition, not the live row", async () => {
    const user = userEvent.setup();
    const onAccept = jest.fn();
    const { rerender } = render(
      <FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />,
    );

    await enterBill(user, "2.00");
    // A refetch that does not change anything must not change the precondition.
    rerender(<FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />);
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 200, ifUnitCostCents: 100 },
      { id: 2, unitCostCents: 200, ifUnitCostCents: 100 },
    ]);
  });

  it("an unpriced line's precondition is NULL, not 0 (unknown is not free)", async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel({
      lines: [
        { id: 1, description: "Priced", qty: 1, qtySource: "counted", baseCents: 100 },
        { id: 2, description: "Unpriced", qty: 1, qtySource: "counted", baseCents: null },
      ],
    });

    await enterBill(user, "1.00");
    await user.clear(allocationInput(1));
    await user.type(allocationInput(1), "50");
    await user.clear(allocationInput(2));
    await user.type(allocationInput(2), "50");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // Line 2 has no base, so it is not writable at all — the only precondition
    // sent is line 1's frozen 100c.
    expect(onAccept).toHaveBeenCalledWith([
      { id: 1, unitCostCents: 150, ifUnitCostCents: 100 },
    ]);
  });

  it("PIN 1: a COST_DRIFT refusal invalidates the WHOLE bill by name, with no partial report", async () => {
    const user = userEvent.setup();
    const drift = Object.assign(
      new Error("Staging item 2: the cost changed while the bill was open"),
      { code: "COST_DRIFT" },
    );
    const onAccept = jest.fn().mockRejectedValue(drift);
    render(<FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // FD3-1: the bill was ONE transaction, so a drift on line 2 rolled line 1
    // back with it. Nothing may report a line as written, and the invalidation
    // — not a partial-write notice — is what the operator sees.
    expect(screen.queryByTestId("line-written")).not.toBeInTheDocument();
    expect(screen.queryByTestId("allocation-write-failed")).not.toBeInTheDocument();
    const invalidated = await screen.findByTestId("allocation-invalidated");
    expect(invalidated).toHaveTextContent(/cost/i);
    expect(invalidated).toHaveTextContent(/re-enter the bill/i);
    // NOTHING may look completed: no applied notice, nothing further writable.
    expect(screen.queryByTestId("allocation-applied")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /allocate/i })).toBeDisabled();
    // ...and there IS a way out.
    expect(screen.getByRole("button", { name: /clear the bill/i })).toBeEnabled();
  });

  it("clearing a drift-invalidated bill starts from nothing", async () => {
    const user = userEvent.setup();
    const drift = Object.assign(new Error("the cost changed while the bill was open"), {
      code: "COST_DRIFT",
    });
    const onAccept = jest.fn().mockRejectedValue(drift);
    render(<FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-invalidated");
    await user.click(screen.getByRole("button", { name: /clear the bill/i }));

    expect(screen.queryByTestId("allocation-invalidated")).not.toBeInTheDocument();
    expect(freightInput()).toHaveValue("");
    expect(freightInput()).not.toHaveAttribute("readonly");
    // ...and a fresh bill can be entered against the costs as they now are.
    await user.type(freightInput(), "2.00");
    expect(screen.getByRole("button", { name: /allocate/i })).toBeEnabled();
  });

  it("an ORDINARY failure (no drift) still keeps the bill retriable", async () => {
    const user = userEvent.setup();
    const onAccept = jest.fn().mockRejectedValue(new Error("Database is unavailable"));
    render(<FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByTestId("allocation-write-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("allocation-invalidated")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// FD2-3 (fix round 3) — no orphaned session state.
//
// `written` outlived `session`: editing the freight total after a partial
// failure dropped the bill but kept the written lines, so Clear (rendered only
// when there was a session) vanished, Allocate stayed blocked by writtenIds, and
// the panel was dead until the page remounted. And Clear was live DURING a
// fan-out, so a late rejection could repopulate state on a bill the operator had
// just thrown away.
//
// FD3-1 killed the orphan at the root: there is no `written` any more. What
// survives is the LIVE half — Clear is reachable from every session state, and
// refused only while a write is in flight.
// ---------------------------------------------------------------------------

describe("the session cannot be orphaned (FD2-3)", () => {
  const PAIR = [
    { id: 1, description: "A", qty: 1, qtySource: "counted" as const, baseCents: 100 },
    { id: 2, description: "B", qty: 1, qtySource: "counted" as const, baseCents: 100 },
  ];

  /** A bill that did not write. Nothing landed, so nothing is left behind. */
  const failing = () => jest.fn().mockRejectedValue(new Error("boom"));

  it("the freight total stays WRITABLE after a failure — the bill did not land", async () => {
    const user = userEvent.setup();
    render(<FreightCalculatorPanel lines={PAIR} onAccept={failing()} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-write-failed");

    expect(freightInput()).not.toHaveAttribute("readonly");
    // A different total is a different bill, and entering one is legal again:
    // no part of this one is sitting in a row cost.
    await user.type(freightInput(), "9");
    expect(freightInput()).toHaveValue("2.009");
    expect(screen.queryByTestId("allocation-row-1")).not.toBeInTheDocument();
  });

  it("Clear is offered on an invalidated bill (its only exit)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <FreightCalculatorPanel lines={PAIR} onAccept={failing()} />,
    );

    await enterBill(user, "2.00");
    // A line leaves the shipment: the bill is invalidated and cannot be accepted.
    rerender(<FreightCalculatorPanel lines={[PAIR[0]]} onAccept={failing()} />);

    expect(screen.getByTestId("allocation-invalidated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear the bill/i })).toBeEnabled();
  });

  it("clearing recovers the panel completely (Allocate live, input writable)", async () => {
    const user = userEvent.setup();
    render(<FreightCalculatorPanel lines={PAIR} onAccept={failing()} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByTestId("allocation-write-failed");
    await user.click(screen.getByRole("button", { name: /clear the bill/i }));

    expect(freightInput()).toHaveValue("");
    expect(freightInput()).not.toHaveAttribute("readonly");
    expect(screen.queryByTestId("allocation-write-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("line-written")).not.toBeInTheDocument();
    await user.type(freightInput(), "1.00");
    expect(screen.getByRole("button", { name: /allocate/i })).toBeEnabled();
  });

  it("Clear and the freight input are DISABLED while a fan-out is in flight", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const onAccept = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(<FreightCalculatorPanel lines={PAIR} onAccept={onAccept} />);

    await enterBill(user, "2.00");
    await user.click(screen.getByRole("button", { name: /accept/i }));

    // The writes are out and their outcome is unknown: nothing may be thrown
    // away underneath them, or a late completion lands on a cleared bill.
    expect(screen.getByRole("button", { name: /clear the bill/i })).toBeDisabled();
    expect(freightInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();

    release?.();
    // The write landed: the compounding guard clears the bill, and the panel is
    // usable again (no orphaned lock, no stranded Clear).
    await screen.findByTestId("allocation-applied");
    expect(freightInput()).toBeEnabled();
    expect(freightInput()).not.toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: /clear the bill/i }),
    ).not.toBeInTheDocument();
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
