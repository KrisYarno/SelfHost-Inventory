/** @jest-environment jsdom */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { flushSync } from "react-dom";

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

  /**
   * Holds the NEXT adjust POST until the returned release is called; it then
   * answers with `adjustAnswer`. Every other request answers as usual.
   */
  function holdNextAdjust(): () => void {
    const answer = fetchMock.getMockImplementation() as (url: RequestInfo | URL, init?: RequestInit) => unknown;
    let release: () => void = () => {
      throw new Error("no adjust request was held");
    };
    let holding = true;
    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      if (holding && String(url) === "/api/inventory/adjust") {
        holding = false;
        return new Promise((resolve) => {
          release = () =>
            resolve({
              ok: adjustAnswer.status < 400,
              status: adjustAnswer.status,
              json: async () => adjustAnswer.body,
            } as unknown as Response);
        });
      }
      return answer(url, init);
    });
    return () => release();
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

  // B3-1 FR1 (CR-1 / OC-6): the inventory page keeps ONE dialog mounted and
  // swaps `product` under it, building a fresh object on every open
  // (`app/(app)/inventory/page.tsx`). A capture entered for A and Cancelled
  // must not ride along on B's removal; reopening A itself keeps it.
  describe("the capture belongs to ONE product", () => {
    const PRODUCT_A = { id: 42, name: "AOD 2mg" };
    const PRODUCT_B = { id: 43, name: "BPC 5mg" };

    /** The page's shape: one mounted dialog, a fresh product object per open. */
    function PageHost() {
      const [open, setOpen] = React.useState(true);
      const [product, setProduct] = React.useState({ ...PRODUCT_A });
      const openFor = (next: typeof PRODUCT_A) => {
        setProduct({ ...next });
        setOpen(true);
      };
      return (
        <>
          <button type="button" onClick={() => openFor(PRODUCT_A)}>Adjust A</button>
          <button type="button" onClick={() => openFor(PRODUCT_B)}>Adjust B</button>
          <QuickAdjustDialog open={open} onOpenChange={setOpen} product={product} onSuccess={() => {}} />
        </>
      );
    }

    async function readyOnPage(user: User) {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <PageHost />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());
      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
    }

    /** Cancel, then open the dialog again for `which`. */
    async function cancelAndOpen(user: User, which: "Adjust A" | "Adjust B") {
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByTestId("order-capture")).toBeNull());
      await user.click(screen.getByRole("button", { name: which }));
      await waitFor(() => expect(screen.getByTestId("order-capture")).toBeInTheDocument());
    }

    it("A → pick → Cancel → B: the capture is EMPTY and the body sends no identity", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await readyOnPage(user);
      await intoCapture(user);
      await pickOrder(user);

      await cancelAndOpen(user, "Adjust B");

      // Sign and chip are remembered (registered), so the capture shows — empty.
      expect(screen.getByText("BPC 5mg")).toBeInTheDocument();
      expect(screen.queryByTestId("order-lookup-picked")).toBeNull();
      expect(screen.getByLabelText("Find the order")).toHaveValue("");
      expect(referenceField()).toHaveValue("");

      const body = await submit(user);
      expect(body).toMatchObject({ productId: 43, delta: -3, intent: "order" });
      expect("selectedExternalOrderId" in body).toBe(false);
      expect("orderReference" in body).toBe(false);
    });

    it("A → type a reference → Cancel → B: the reference is gone and the body sends none", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await readyOnPage(user);
      await intoCapture(user);
      await user.type(referenceField(), "1009");

      await cancelAndOpen(user, "Adjust B");

      expect(screen.getByText("BPC 5mg")).toBeInTheDocument();
      expect(referenceField()).toHaveValue("");
      expect(screen.queryByTestId("order-lookup-picked")).toBeNull();

      const body = await submit(user);
      expect(body).toMatchObject({ productId: 43, delta: -3, intent: "order" });
      expect("orderReference" in body).toBe(false);
      expect("selectedExternalOrderId" in body).toBe(false);
    });

    it("A → pick → Cancel → A again (a fresh object, the same id): the pick is KEPT", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await readyOnPage(user);
      await intoCapture(user);
      await pickOrder(user);

      await cancelAndOpen(user, "Adjust A");

      expect(screen.getByTestId("order-lookup-picked")).toHaveTextContent("Order 2044");
      const body = await submit(user);
      expect(body).toMatchObject({ productId: 42, delta: -3, intent: "order" });
      expect(body.selectedExternalOrderId).toBe("ord-2");
    });

    it("A → type a reference → Cancel → A again: the reference is KEPT", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await readyOnPage(user);
      await intoCapture(user);
      await user.type(referenceField(), "1009");

      await cancelAndOpen(user, "Adjust A");

      expect(referenceField()).toHaveValue("1009");
      const body = await submit(user);
      expect(body).toMatchObject({ productId: 42, delta: -3, intent: "order" });
      expect(body.orderReference).toBe("1009");
    });

    // B3-1 FD1-1: clearing the capture in an EFFECT leaves one COMMITTED render
    // of product B still holding A's capture — Confirm enabled, its handler
    // pairing B's id with A's order — until the effect's own render lands. The
    // reset happens DURING render instead, so no commit ever pairs them. The
    // probe reads the screen in a layout effect, which runs after every commit
    // and BEFORE any passive effect: the instant the old code was exposed.
    //
    // The product is swapped while the dialog stays MOUNTED (no Cancel, and no
    // click outside it): after a close, Radix remounts the portal one commit
    // late, by which time React has flushed the effect, so jsdom would hide the
    // window. A real browser does not reliably — a reopen during the close
    // animation keeps the portal mounted — so the swap-while-mounted shape is
    // the one that can tell the two implementations apart.
    it.each([
      ["a pick", async (user: User) => pickOrder(user)],
      ["a typed reference", async (user: User) => user.type(referenceField(), "1009")],
    ])("no COMMITTED render ever shows product B with A's capture (%s)", async (_label, enter) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const mismatches: string[] = [];
      function CommitProbe() {
        React.useLayoutEffect(() => {
          const showsB = document.body.textContent?.includes(PRODUCT_B.name) ?? false;
          const picked = document.querySelector('[data-testid="order-lookup-picked"]');
          const ref = document.getElementById("order-reference") as HTMLInputElement | null;
          if (showsB && (picked !== null || (ref !== null && ref.value !== ""))) {
            mismatches.push(`picked=${picked?.textContent ?? "-"}; reference=${ref?.value ?? "-"}`);
          }
        });
        return null;
      }
      // The swap is driven from OUTSIDE React's event system: a click on a
      // button beside a Radix modal is an "interact outside", which closes the
      // dialog first and remounts its portal — exactly the timing that hides
      // the window. A programmatic swap keeps the dialog mounted throughout.
      let swapToB: () => void = () => {};
      function ProbedHost() {
        const [open, setOpen] = React.useState(true);
        const [product, setProduct] = React.useState({ ...PRODUCT_A });
        swapToB = () => setProduct({ ...PRODUCT_B });
        return (
          <>
            <QuickAdjustDialog open={open} onOpenChange={setOpen} product={product} onSuccess={() => {}} />
            <CommitProbe />
          </>
        );
      }
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <ProbedHost />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());
      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
      await intoCapture(user);
      await enter(user);

      // Swap the product under the MOUNTED dialog.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      act(() => swapToB());
      expect(screen.getByText(PRODUCT_B.name)).toBeInTheDocument();

      expect(mismatches).toEqual([]);
      // And the capture B shows is empty.
      expect(screen.queryByTestId("order-lookup-picked")).toBeNull();
      expect(referenceField()).toHaveValue("");
    });

    // B3-1 FR3 (Q/A B3-1-QA-1): FR2's render-phase reset was right only if
    // React's scheduling cooperated. A submit on A that settles AFTER the
    // product changed queues the form's resets at DEFAULT priority. A SYNC
    // render of B skips them, and React 18 then rebuilds each skipped hook from
    // a base state the render-phase clear never advanced — so the NEXT sync
    // render showed A's order under B, and Confirm sent it with B's id.
    //
    // Q/A reached that window by dismissing the dialog mid-submit, a path now
    // closed (below). The product is swapped from the HOST here instead, so this
    // pin proves the capture's own construction — stored WITH the id of the
    // product it was entered under — closes it whatever dismissal allows. Steps
    // 4 to 6 run in `flushSync` OUTSIDE `act`: `act` would flush the queued
    // default-priority resets on exit, which is exactly the window under test.
    it.each([
      ["a pick", async (user: User) => pickOrder(user)],
      ["a typed reference", async (user: User) => user.type(referenceField(), "1009")],
    ])("A's submit settling under B never pairs B with A's capture, whatever React's scheduling (%s)", async (_label, enter) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      let swapToB: () => void = () => {};
      function SwapHost() {
        const [open, setOpen] = React.useState(true);
        const [product, setProduct] = React.useState({ ...PRODUCT_A });
        swapToB = () => setProduct({ ...PRODUCT_B });
        return <QuickAdjustDialog open={open} onOpenChange={setOpen} product={product} onSuccess={() => {}} />;
      }
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      // B's stock is already known, so B's first synchronous render can enable
      // Confirm — the window this needs.
      client.setQueryData(["product-location-quantity", PRODUCT_B.id, 2], 40);
      render(
        <QueryClientProvider client={client}>
          <SwapHost />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());
      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
      await intoCapture(user);
      await enter(user);

      // 1. Submit on A, with the request held.
      const releaseA = holdNextAdjust();
      await user.click(confirmButton());
      await waitFor(() => expect(adjustCalls()).toHaveLength(1));
      expect(screen.getByRole("button", { name: "Adjusting..." })).toBeDisabled();

      // From here to Confirm, React runs OUTSIDE `act` on purpose; the flag
      // only silences the warning that says so.
      const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const wasActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
      actEnv.IS_REACT_ACT_ENVIRONMENT = false;
      let shownUnderB: { product: boolean; picked: string | null; reference: string | null };
      try {
        // 2-3. A's request resolves, and its continuation queues the resets at
        // default priority. Only MICROTASKS are drained, so React's scheduler
        // (a macrotask) has not rendered them yet.
        releaseA();
        for (let i = 0; i < 500 && toastWarning.mock.calls.length === 0; i++) await Promise.resolve();
        expect(toastWarning).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText("Quantity")).toHaveValue(3);

        // 4. B, in a sync render.
        flushSync(() => swapToB());
        // 5. A second sync render of B.
        flushSync(() => screen.getByRole("button", { name: "Increase quantity" }).click());
        shownUnderB = {
          product: screen.queryByText(PRODUCT_B.name) !== null,
          picked: document.querySelector('[data-testid="order-lookup-picked"]')?.textContent ?? null,
          reference: (document.getElementById("order-reference") as HTMLInputElement | null)?.value ?? null,
        };
        // 6. Confirm, in a sync render.
        flushSync(() => confirmButton().click());
      } finally {
        actEnv.IS_REACT_ACT_ENVIRONMENT = wasActEnv;
      }

      await waitFor(() => expect(adjustCalls()).toHaveLength(2));
      const body = JSON.parse((adjustCalls()[1][1] as RequestInit).body as string);
      expect({
        shownUnderB,
        productId: body.productId,
        delta: body.delta,
        selectedExternalOrderId: body.selectedExternalOrderId ?? null,
        orderReference: body.orderReference ?? null,
      }).toEqual({
        shownUnderB: { product: true, picked: null, reference: "" },
        productId: PRODUCT_B.id,
        delta: -4,
        selectedExternalOrderId: null,
        orderReference: null,
      });
      expect("selectedExternalOrderId" in body).toBe(false);
      expect("orderReference" in body).toBe(false);

      // Let B's own answer and A's queued resets land before the next test.
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  });

  // B3-1 FR3 (FD2-3): a submit in flight cannot be dismissed — not by Escape,
  // a click outside, or the close button. Q/A's reproduction above began with
  // exactly that dismissal. The request's own answer still closes the dialog,
  // as it always has; an idle dialog dismisses as it always has.
  describe("a submit in flight cannot be dismissed", () => {
    function GuardHost({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button type="button">Beside the dialog</button>
          <QuickAdjustDialog
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
            product={{ id: 42, name: "AOD 2mg" }}
            onSuccess={() => {}}
          />
        </>
      );
    }

    async function readyInGuardHost(user: User, onOpenChange: (open: boolean) => void) {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <GuardHost onOpenChange={onOpenChange} />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());
      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
    }

    const DISMISSALS: Array<[string, (user: User) => Promise<void>]> = [
      ["Escape", (user) => user.keyboard("{Escape}")],
      // Outside the modal, so the accessibility tree hides it.
      ["a click outside", (user) => user.click(screen.getByRole("button", { name: "Beside the dialog", hidden: true }))],
      ["the close button", (user) => user.click(screen.getByRole("button", { name: "Close" }))],
    ];

    it.each(DISMISSALS)("%s does not close it while the request is in flight; the answer does", async (_how, dismiss) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const onOpenChange = jest.fn();
      await readyInGuardHost(user, onOpenChange);

      const release = holdNextAdjust();
      await user.click(confirmButton());
      await waitFor(() => expect(screen.getByRole("button", { name: "Adjusting..." })).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

      await dismiss(user);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Adjusting..." })).toBeInTheDocument();

      release();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onOpenChange.mock.calls).toEqual([[false]]);
      expect(toastSuccess).toHaveBeenCalledWith("Added 3 units to AOD 2mg");
    });

    it.each(DISMISSALS)("%s still closes an idle dialog", async (_how, dismiss) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const onOpenChange = jest.fn();
      await readyInGuardHost(user, onOpenChange);

      await dismiss(user);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(adjustCalls()).toHaveLength(0);
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

    it("the unmatched warning is held for 10 s (B3-1 FR1, OC-3) — the success toasts are not", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: null }, batchId: "b-1" };
      await ready(user);
      await intoCapture(user);
      await user.type(referenceField(), "1009");

      await submit(user);
      await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
      expect(toastWarning.mock.calls[0]).toEqual([UNMATCHED(3), { duration: 10000 }]);

      // The success toasts keep sonner's default: no options at all.
      adjustAnswer.body = { success: true, log: { id: 2, orderRecordId: "ord-9" }, batchId: "b-2" };
      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
      await intoCapture(user);
      await user.type(referenceField(), "1009");
      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      expect(toastSuccess.mock.calls[0]).toEqual(["Removed 3 units — attributed to order 1009"]);

      await user.type(screen.getByLabelText("Quantity"), "3");
      await user.type(screen.getByLabelText("Reason (required)"), "packed");
      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2));
      expect(toastSuccess.mock.calls[1]).toEqual(["Added 3 units to AOD 2mg"]);
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
