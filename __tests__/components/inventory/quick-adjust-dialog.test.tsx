/** @jest-environment jsdom */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ selectedLocationId: 2, locations: [{ id: 2, name: "Office" }] }),
}));

// P2-B3-1: the capture's order lookup reads the shared search hook; its own
// behaviour is pinned in order-lookup.test.tsx, so here it answers on cue.
const useOrderSearchMock = jest.fn();
jest.mock("@/hooks/use-order-search", () => ({
  useOrderSearch: (q: string) => useOrderSearchMock(q),
}));

const toastSuccess = jest.fn();
const toastWarning = jest.fn();
const toastError = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    error: (...a: unknown[]) => toastError(...a),
    message: jest.fn(),
  },
}));

type User = ReturnType<typeof userEvent.setup>;

import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);

test("shows loading then the fetched per-location quantity (never a passed-in total)", async () => {
  let resolveQty!: (v: unknown) => void;
  global.fetch = jest.fn((url: RequestInfo | URL) => {
    if (String(url).includes("/api/inventory/product/")) return new Promise((r) => (resolveQty = r));
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
  wrap(<QuickAdjustDialog open onOpenChange={() => {}} product={{ id: 42, name: "AOD 2mg" }} onSuccess={() => {}} />);
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
  resolveQty({ ok: true, json: async () => ({ currentQuantity: 7 }) });
  await waitFor(() => expect(screen.getByText(/7/)).toBeInTheDocument());
});

// ===========================================================================
// THE CAPTURE (reconciliation Part 2, pack CB3b-ii.1b + § P2-B3-1, B3-1b).
//
// On a Remove under the `order` chip the dialog takes the order: picked from
// the search (`selectedExternalOrderId`) or typed (`orderReference`), never
// both. Pinned here: WHEN the two fields exist (and that leaving that state
// clears them), the body each path sends, the both-filled refusal, the client
// shape check, and the two new toasts byte for byte — with today's toasts
// unchanged whenever no identity was attempted.
// ===========================================================================

describe("the capture", () => {
  const ATTRIBUTED = (n: number, order: string) => `Removed ${n} units — attributed to order ${order}`;
  const UNMATCHED = (n: number) =>
    `Removed ${n} units — the reference was not matched to an order you can see; the deduction is recorded unattributed`;

  const ORDER_2044 = {
    id: "ord-2",
    orderNumber: "2044",
    platform: "woocommerce",
    internalStatus: "PROCESSING",
    externalCreatedAt: "2026-08-19T09:00:00.000Z",
    itemCount: 4,
  };

  /** What the adjust route answers on the next submit. */
  let adjustAnswer: { status: number; body: Record<string, unknown> };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    useOrderSearchMock.mockImplementation((q: string) => ({
      data: q.length >= 1 ? { orders: [ORDER_2044], moreCount: 0 } : undefined,
      isError: false,
      isLoading: false,
    }));
    adjustAnswer = {
      status: 200,
      body: { success: true, log: { id: 1, orderRecordId: null }, newVersion: 2, batchId: "b-1" },
    };
    fetchMock = jest.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/inventory/product/")) {
        return { ok: true, json: async () => ({ currentQuantity: 40 }) } as unknown as Response;
      }
      return {
        ok: adjustAnswer.status < 400,
        status: adjustAnswer.status,
        json: async () => adjustAnswer.body,
      } as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function renderDialog() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <QuickAdjustDialog open onOpenChange={() => {}} product={{ id: 42, name: "AOD 2mg" }} onSuccess={() => {}} />
      </QueryClientProvider>,
    );
  }

  const chipGroup = () => within(screen.getByRole("radiogroup", { name: "What was this for?" }));
  const tapChip = (user: User, name: string) => user.click(chipGroup().getByRole("radio", { name }));
  const tapSign = (user: User, sign: "Add Stock" | "Remove Stock") =>
    user.click(screen.getByRole("radio", { name: sign }));
  const confirmButton = () => screen.getByRole("button", { name: /confirm adjustment/i });
  const referenceField = () => screen.getByLabelText("Or type the order number");
  const adjustCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/inventory/adjust");

  async function ready(user: User) {
    renderDialog();
    await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());
    await user.type(screen.getByLabelText("Quantity"), "3");
    await user.type(screen.getByLabelText("Reason (required)"), "packed");
  }

  /** Remove + the `order` chip: the capture's state. */
  async function intoCapture(user: User) {
    await tapSign(user, "Remove Stock");
    await tapChip(user, "Order");
    await waitFor(() => expect(screen.getByTestId("order-capture")).toBeInTheDocument());
  }

  async function pickOrder(user: User) {
    await user.type(screen.getByLabelText("Find the order"), "2044");
    await waitFor(() => expect(screen.getByTestId("order-lookup-result-ord-2")).toBeInTheDocument());
    await user.click(screen.getByTestId("order-lookup-result-ord-2"));
    expect(screen.getByTestId("order-lookup-picked")).toHaveTextContent("Order 2044");
  }

  /** Confirm, wait for the POST, and hand back the body it carried. */
  async function submit(user: User): Promise<Record<string, unknown>> {
    const before = adjustCalls().length;
    await user.click(confirmButton());
    await waitFor(() => expect(adjustCalls().length).toBe(before + 1));
    const call = adjustCalls()[before];
    return JSON.parse((call[1] as RequestInit).body as string);
  }

  describe("when the fields exist", () => {
    it("absent on Add (even under `order`), absent under the other chips, present on Remove + Order", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);

      await tapChip(user, "Order");
      expect(screen.queryByTestId("order-capture")).toBeNull();
      expect(screen.queryByLabelText("Find the order")).toBeNull();
      expect(screen.queryByLabelText("Or type the order number")).toBeNull();

      await tapSign(user, "Remove Stock");
      await tapChip(user, "Damage / loss");
      expect(screen.queryByTestId("order-capture")).toBeNull();
      await tapChip(user, "Other");
      expect(screen.queryByTestId("order-capture")).toBeNull();

      await tapChip(user, "Order");
      expect(screen.getByLabelText("Find the order")).toBeInTheDocument();
      expect(referenceField()).toBeInTheDocument();
    });

    it("an untapped chip on Remove shows no capture", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await tapSign(user, "Remove Stock");
      expect(screen.queryByTestId("order-capture")).toBeNull();
    });
  });

  describe("leaving the state clears both", () => {
    it("Order → Other: the typed reference is gone, and the submit carries no identity", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "1009");

      await tapChip(user, "Other");
      expect(screen.queryByTestId("order-capture")).toBeNull();
      await tapChip(user, "Order");
      expect(referenceField()).toHaveValue("");
      await tapChip(user, "Other");

      const body = await submit(user);
      expect(body.intent).toBe("other");
      expect("orderReference" in body).toBe(false);
      expect("selectedExternalOrderId" in body).toBe(false);
    });

    it("Order → Damage: the picked order is gone, and the submit carries no identity", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);

      await tapChip(user, "Damage / loss");

      const body = await submit(user);
      expect(body.intent).toBe("damage-loss");
      expect("orderReference" in body).toBe(false);
      expect("selectedExternalOrderId" in body).toBe(false);
    });

    it("Remove → Add clears the picked order AND the typed reference", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);
      await user.type(referenceField(), "1009");

      await tapSign(user, "Add Stock");
      expect(screen.queryByTestId("order-capture")).toBeNull();
      await tapSign(user, "Remove Stock");

      // The chip stayed on `order`, so the capture is back — EMPTY.
      expect(screen.getByTestId("order-capture")).toBeInTheDocument();
      expect(screen.queryByTestId("order-lookup-picked")).toBeNull();
      expect(screen.getByLabelText("Find the order")).toBeInTheDocument();
      expect(referenceField()).toHaveValue("");
      expect(screen.queryByTestId("order-capture-conflict")).toBeNull();
    });

    it("a successful submit resets both — the next adjustment starts clean", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-9" }, batchId: "b-1" };
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "1009");

      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

      // The form reset to Add with no chip: no capture at all.
      expect(screen.queryByTestId("order-capture")).toBeNull();
      await intoCapture(user);
      expect(referenceField()).toHaveValue("");
      expect(screen.queryByTestId("order-lookup-picked")).toBeNull();
    });

    it("a successful submit after a PICK resets the pick too", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-2" }, batchId: "b-1" };
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);

      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

      await intoCapture(user);
      expect(screen.queryByTestId("order-lookup-picked")).toBeNull();
      expect(screen.getByLabelText("Find the order")).toHaveValue("");
    });
  });

  describe("the body, per path", () => {
    it("picked → selectedExternalOrderId only", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);

      const body = await submit(user);
      expect(body).toMatchObject({ productId: 42, locationId: 2, delta: -3, intent: "order" });
      expect(body.selectedExternalOrderId).toBe("ord-2");
      expect("orderReference" in body).toBe(false);
    });

    it("typed → orderReference only, trimmed", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "  1009  ");

      const body = await submit(user);
      expect(body).toMatchObject({ delta: -3, intent: "order" });
      expect(body.orderReference).toBe("1009");
      expect("selectedExternalOrderId" in body).toBe(false);
    });

    it("a blank (whitespace-only) reference is left OUT of the body", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "   ");

      expect(confirmButton()).toBeEnabled();
      const body = await submit(user);
      expect(body.intent).toBe("order");
      expect("orderReference" in body).toBe(false);
      expect("selectedExternalOrderId" in body).toBe(false);
    });
  });

  describe("both filled: the dialog refuses before the server could", () => {
    it("shows the sentence, keeps Confirm dead, and never calls the mutation", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);
      await user.type(referenceField(), "1009");

      expect(screen.getByTestId("order-capture-conflict")).toHaveTextContent(
        /^Pick the order or type the reference, not both$/,
      );
      expect(confirmButton()).toBeDisabled();
      await user.click(confirmButton());
      expect(adjustCalls()).toHaveLength(0);
    });

    it("clearing either side lifts the refusal", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);
      await user.type(referenceField(), "1009");

      await user.click(screen.getByRole("button", { name: "Clear order 2044" }));
      expect(screen.queryByTestId("order-capture-conflict")).toBeNull();
      expect(confirmButton()).toBeEnabled();
    });
  });

  describe("the client shape check", () => {
    it("a reference that is not digits shows the hint and keeps Confirm dead until fixed", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "#1009");

      expect(screen.getByText("digits only, without #")).toBeInTheDocument();
      expect(referenceField()).toHaveAttribute("aria-invalid", "true");
      expect(confirmButton()).toBeDisabled();
      await user.click(confirmButton());
      expect(adjustCalls()).toHaveLength(0);

      await user.clear(referenceField());
      await user.type(referenceField(), "1009");
      expect(screen.queryByText("digits only, without #")).toBeNull();
      expect(confirmButton()).toBeEnabled();
    });

    it("more than twenty digits fails the same bar", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "1".repeat(21));

      expect(screen.getByText("digits only, without #")).toBeInTheDocument();
      expect(confirmButton()).toBeDisabled();
    });
  });

  describe("the toasts", () => {
    it("stamped from a TYPED reference → attributed to the typed text", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-9" }, batchId: "b-1" };
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), " 1009 ");

      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      expect(toastSuccess).toHaveBeenCalledWith(ATTRIBUTED(3, "1009"));
      expect(toastSuccess.mock.calls[0][0]).toBe("Removed 3 units — attributed to order 1009");
      expect(toastWarning).not.toHaveBeenCalled();
    });

    it("stamped from a PICK → attributed to the picked number", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-2" }, batchId: "b-1" };
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);

      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      expect(toastSuccess.mock.calls[0][0]).toBe("Removed 3 units — attributed to order 2044");
    });

    it("a reference the server did not stamp → the ONE unmatched sentence", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: null }, batchId: "b-1" };
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "1009");

      await submit(user);
      await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
      expect(toastWarning.mock.calls[0][0]).toBe(UNMATCHED(3));
      expect(toastWarning.mock.calls[0][0]).toBe(
        "Removed 3 units — the reference was not matched to an order you can see; the deduction is recorded unattributed",
      );
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("a 200 with no log stamp at all reads as not stamped, never as attributed", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer.body = { success: true };
      await ready(user);
      await intoCapture(user);
      await pickOrder(user);

      await submit(user);
      await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
      expect(toastWarning.mock.calls[0][0]).toBe(UNMATCHED(3));
    });

    it("no identity attempted → today's toasts, unchanged", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      // Even a stamped 200 (an API-side stamp) does not change a toast the
      // operator did not ask for.
      adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-9" }, batchId: "b-1" };
      await ready(user);

      // Add.
      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      expect(toastSuccess.mock.calls[0][0]).toBe("Added 3 units to AOD 2mg");

      // Remove under `order`, nothing filled.
      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
      await intoCapture(user);
      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2));
      expect(toastSuccess.mock.calls[1][0]).toBe("Removed 3 units from AOD 2mg");

      // Remove with no chip.
      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
      await tapSign(user, "Remove Stock");
      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(3));
      expect(toastSuccess.mock.calls[2][0]).toBe("Removed 3 units from AOD 2mg");
      expect(toastWarning).not.toHaveBeenCalled();
    });

    it("a server 400 still renders the server's own sentence", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer = {
        status: 400,
        body: {
          error: "a reference attributes stock that left — put stock back with a correction",
          code: "VALIDATION_ERROR",
        },
      };
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "1009");

      await submit(user);
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(toastError.mock.calls[0][0]).toBe(
        "a reference attributes stock that left — put stock back with a correction",
      );
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastWarning).not.toHaveBeenCalled();
    });
  });
});
