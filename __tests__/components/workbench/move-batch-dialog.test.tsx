/** @jest-environment jsdom */
//
// THE ONE MOVE DIALOG (reconciliation Part 2, pack CB2c.4; spec §2.6).
//
// Two surfaces open this dialog and it behaves identically for both, because it
// owns everything except the request: the select, the consequence sentence, the
// confirm and how a refusal renders. What is pinned here is the four ways it
// could mislead:
//
//   1. OFFERING THE ONE ANSWER THE SERVER REFUSES. The ledger location is not
//      in the select — choosing it is SAME_LOCATION, every time.
//   2. POSTING FOR THE FULFILMENT BATCH. It never does (PK-1): a non-null
//      `fulfilBatchId` gets a SENTENCE and no request, because the repair for a
//      fulfilment's wrong location lives in unfulfill + refulfil.
//   3. PRINTING THE CALLER'S NUMBER AS THE SERVER'S. The consequence line says
//      "asked"; the result line reads the 200's own `pairs`.
//   4. PARAPHRASING A REFUSAL. The server's sentence renders verbatim (F7).

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("@/hooks/use-locations", () => ({
  useLocations: () => ({
    data: [
      { id: 1, name: "Main" },
      { id: 2, name: "Overflow" },
      { id: 3, name: "Returns" },
    ],
    isLoading: false,
  }),
}));

import {
  MoveBatchDialog,
  MOVE_ORDER_LEG_SENTENCE,
  type MoveResponse,
  type MoveTarget,
} from "@/components/workbench/move-batch-dialog";

const MANUAL_BATCH = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const FULFIL_BATCH = "9a1b7c22-1111-4d3d-8a0c-0305e82c3399";

function target(over: Partial<MoveTarget> = {}): MoveTarget {
  return {
    batchIds: { deductSimpleBatchId: MANUAL_BATCH, fulfilBatchId: null },
    ledgerLocationId: 1,
    ledgerLocationName: "Main",
    units: 5,
    orderRef: "ORD-1",
    refKind: "order",
    caller: "workbench",
    ...over,
  };
}

function answer(over: Partial<MoveResponse> = {}): MoveResponse {
  return {
    movedBatchId: MANUAL_BATCH,
    batchId: "new-batch",
    orderRecordId: null,
    ledgerLocationId: 1,
    physicalLocationId: 2,
    pairs: [{ productId: 9, units: 4, transferId: "t-1" }],
    rows: [
      { productId: 9, locationId: 2, delta: -4 },
      { productId: 9, locationId: 1, delta: 4 },
    ],
    message: "moved 4 units from location 1 to 2",
    ...over,
  };
}

function renderDialog(
  over: Partial<MoveTarget> | null = {},
  onConfirm: jest.Mock = jest.fn(async () => answer()),
) {
  const onOpenChange = jest.fn();
  render(
    <MoveBatchDialog
      target={over === null ? null : target(over)}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm as unknown as (id: number) => Promise<MoveResponse>}
    />,
  );
  return { onConfirm, onOpenChange };
}

const locationSelect = () => screen.getByTestId("move-dialog-location") as HTMLSelectElement;
const confirmButton = () => screen.getByTestId("move-dialog-confirm");

describe("MoveBatchDialog — the select", () => {
  it("renders nothing at all when there is no target", () => {
    renderDialog(null);
    expect(screen.queryByTestId("move-dialog-location")).toBeNull();
  });

  it("EXCLUDES the ledger location — the one answer the server always refuses", () => {
    renderDialog({ ledgerLocationId: 1 });

    const values = Array.from(locationSelect().options).map((option) => option.value);
    expect(values).toEqual(["", "2", "3"]);
    expect(screen.queryByRole("option", { name: "Main" })).toBeNull();
  });

  it("the confirm is dead until a location is chosen", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onConfirm } = renderDialog();

    expect(confirmButton()).toBeDisabled();
    await user.selectOptions(locationSelect(), "2");
    expect(confirmButton()).toBeEnabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("MoveBatchDialog — the consequence line's units follow the CALLER (F3)", () => {
  // The workbench's number is what the completion ASKED for, seconds ago, and
  // the server may yet move less. The drill-down's is the batch's outbound Σ as
  // the report READ it off the ledger. Two different facts, two labels — one
  // number presented as the other is the untruthful half of this sentence.
  it("the WORKBENCH's units are the ones it ASKED for", () => {
    renderDialog({ units: 5, ledgerLocationName: "Main", caller: "workbench" });

    expect(screen.getByTestId("move-consequence")).toHaveTextContent(
      "Moves this batch's books (5 units asked) from Main to the chosen location — the order stays attributed",
    );
  });

  it("the DRILL-DOWN's units are the ones ON THE LEDGER", () => {
    renderDialog({ units: 5, ledgerLocationName: "Main", caller: "drilldown" });

    expect(screen.getByTestId("move-consequence")).toHaveTextContent(
      "Moves this batch's books (5 units on the ledger) from Main to the chosen location — the order stays attributed",
    );
  });

  it("the RESULT line prints the SERVER's units, not the caller's", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // The caller asked about 5; the server moved 4.
    renderDialog({ units: 5 });

    await user.selectOptions(locationSelect(), "2");
    await user.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId("move-result-manual")).toBeInTheDocument());
    expect(screen.getByTestId("move-result-manual")).toHaveTextContent(
      "manual leg: moved 4 units",
    );
  });
});

describe("MoveBatchDialog — the header names what the ref actually IS (F13)", () => {
  // The drill-down falls back to the BATCH id when the row names no order
  // number, and a uuid introduced as `Order <uuid>` is a claim the surface
  // cannot support. `refKind` says which of the two the caller handed over.
  it("an ORDER ref reads `Order …`", () => {
    renderDialog({ orderRef: "ORD-1", refKind: "order" });

    expect(
      screen.getByText("Order ORD-1 — where did this stock actually leave from?"),
    ).toBeInTheDocument();
  });

  it("a BATCH ref reads `Batch …`", () => {
    renderDialog({ orderRef: MANUAL_BATCH, refKind: "batch" });

    expect(
      screen.getByText(`Batch ${MANUAL_BATCH} — where did this stock actually leave from?`),
    ).toBeInTheDocument();
  });
});

describe("MoveBatchDialog — ONE request, for the manual batch only (PK-1)", () => {
  it("a MANUAL-ONLY target calls onConfirm exactly once, with the chosen location", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onConfirm } = renderDialog();

    await user.selectOptions(locationSelect(), "3");
    await user.click(confirmButton());

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(3);
    // No order leg, no sentence.
    expect(screen.queryByTestId("move-result-order")).toBeNull();
  });

  it("a MIXED cart still makes ONE request, and the order leg gets a SENTENCE", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onConfirm } = renderDialog({
      batchIds: { deductSimpleBatchId: MANUAL_BATCH, fulfilBatchId: FULFIL_BATCH },
    });

    expect(screen.getByTestId("move-result-order")).toHaveTextContent(MOVE_ORDER_LEG_SENTENCE);

    await user.selectOptions(locationSelect(), "2");
    await user.click(confirmButton());

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // ONE call, and it carries the location — the fulfil batch id never leaves
    // this component, because there is no request that could take it.
    expect(onConfirm.mock.calls).toEqual([[2]]);
  });

  it("a WC-ONLY target has no request to make: the confirm is dead and the sentence stands", async () => {
    const { onConfirm } = renderDialog({
      batchIds: { deductSimpleBatchId: null, fulfilBatchId: FULFIL_BATCH },
    });

    expect(screen.getByTestId("move-result-order")).toHaveTextContent(MOVE_ORDER_LEG_SENTENCE);
    expect(confirmButton()).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a second click cannot move the same batch twice", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onConfirm } = renderDialog();

    await user.selectOptions(locationSelect(), "2");
    await user.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId("move-result-manual")).toBeInTheDocument());

    expect(confirmButton()).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("MoveBatchDialog — refusals render VERBATIM (the F7 rule)", () => {
  it("prints the server's own sentence, numbers and all", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const refusal = {
      error:
        "Location 2 has 1 of product 9 on the books — 4 needed to move this batch",
      code: "INSUFFICIENT_AT_SOURCE",
    };
    const onConfirm = jest.fn(async () => {
      throw refusal;
    });
    renderDialog({}, onConfirm as unknown as jest.Mock);

    await user.selectOptions(locationSelect(), "2");
    await user.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId("move-dialog-refusal")).toBeInTheDocument());
    expect(screen.getByTestId("move-dialog-refusal")).toHaveTextContent(refusal.error);
    // Nothing is claimed to have moved.
    expect(screen.queryByTestId("move-result-manual")).toBeNull();
  });

  it("an ALREADY_MOVED refusal keeps its own timestamp sentence", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConfirm = jest.fn(async () => {
      throw {
        error:
          "This batch was moved to location 7 on 2026-09-02 14:31 UTC — it can no longer be re-attributed or moved again",
        code: "ALREADY_MOVED",
      };
    });
    renderDialog({}, onConfirm as unknown as jest.Mock);

    await user.selectOptions(locationSelect(), "2");
    await user.click(confirmButton());

    await waitFor(() =>
      expect(screen.getByTestId("move-dialog-refusal")).toHaveTextContent(
        "moved to location 7 on 2026-09-02 14:31 UTC",
      ),
    );
    // A refused move can be retried at another location.
    expect(confirmButton()).toBeEnabled();
  });

  it("a rejection with no sentence still says something honest, never a blank", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConfirm = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    renderDialog({}, onConfirm as unknown as jest.Mock);

    await user.selectOptions(locationSelect(), "2");
    await user.click(confirmButton());

    await waitFor(() =>
      expect(screen.getByTestId("move-dialog-refusal")).toHaveTextContent(
        "The move could not be completed.",
      ),
    );
  });
});
