/** @jest-environment jsdom */
/**
 * `components/inventory/stock-in-dialog.tsx` — § P2-B3-1R, M-b1 fix 7 (MS-1-1)
 * and the Stock In half of fix 6 (MS-1-5).
 *
 * MS-1-1: the dialog had an "Order/Reference Number" and "Additional Notes",
 * sent them, and the route's schema silently stripped both — the operator's
 * words went nowhere. Now there is ONE `Note (optional)`, sent as `notes`, which
 * the route records (R-a.4) and the product's history shows to admins and its
 * author. No `orderNumber` key is ever sent.
 *
 * The shared submit latch (M-a.1): one stock-in per tap, and no dismissal while
 * it is in flight; the success close goes through the host's raw callback.
 *
 * MS-1-5's typed-state arm: the hosts mount this dialog per open (the page arm
 * is `inventory-page.test.tsx`), so a draft typed for product A is gone when the
 * dialog mounts for product B.
 */

import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
// Mutable so a pin can stand the operator at no location (FR-R1 (4)); every
// other pin is at Office.
const mockLocation: { selectedLocationId: number | null; locations: Array<{ id: number; name: string }> } = {
  selectedLocationId: 2,
  locations: [{ id: 2, name: "Office" }],
};
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => mockLocation,
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

import { toast } from "sonner";
import { StockInDialog } from "@/components/inventory/stock-in-dialog";
import { RECEIVING_PROMPT_SESSION_KEY } from "@/components/inventory/receiving-redirect-prompt";

const PRODUCT_A = { id: 42, name: "AOD 2mg" };
const PRODUCT_B = { id: 43, name: "BPC 5mg" };

type Answer = { status: number; body: Record<string, unknown> };
let stockInAnswer: Answer;
let holdStockIn: Promise<void> | null;
/** The current-stock read: a count, a failure, or an answer that never comes. */
let stockRead: number | "error" | "hang";

function mockFetch() {
  const fn = jest.fn(async (url: RequestInfo | URL) => {
    const href = String(url);
    if (href.includes("/api/inventory/product/")) {
      if (stockRead === "hang") return new Promise<Response>(() => {});
      if (stockRead === "error") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return { ok: true, json: async () => ({ currentQuantity: stockRead }) } as unknown as Response;
    }
    if (href.includes("/api/inventory/stock-in")) {
      if (holdStockIn) await holdStockIn;
      return {
        ok: stockInAnswer.status < 400,
        status: stockInAnswer.status,
        json: async () => stockInAnswer.body,
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** The stock-in POSTs, with their parsed bodies. */
const stockInBodies = () =>
  (global.fetch as jest.Mock).mock.calls
    .filter(([url]) => String(url).includes("/api/inventory/stock-in"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

/** Hold the next stock-in until the returned function is called. */
function holdNextStockIn() {
  let release!: () => void;
  holdStockIn = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    holdStockIn = null;
    release();
  };
}

function renderDialog(
  product: { id: number; name: string } = PRODUCT_A,
  onOpenChange: jest.Mock = jest.fn(),
  onSuccess: jest.Mock = jest.fn(),
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <StockInDialog open onOpenChange={onOpenChange} product={product} onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return { ...view, onOpenChange, onSuccess };
}

const quantityField = () => screen.getByLabelText(/quantity to add/i);
const noteField = () => screen.getByLabelText("Note (optional)");
const actionButton = () => screen.getByRole("button", { name: /^(Add \d+ Units|Adding Stock\.\.\.)$/ });
const cancelButton = () => screen.getByRole("button", { name: "Cancel" });

beforeEach(() => {
  jest.clearAllMocks();
  // The receiving prompt is a once-per-session nudge; mark it as seen so it
  // never stands between these pins and the action.
  window.sessionStorage.clear();
  window.sessionStorage.setItem(RECEIVING_PROMPT_SESSION_KEY, "1");
  stockInAnswer = { status: 200, body: { success: true } };
  holdStockIn = null;
  stockRead = 7;
  mockLocation.selectedLocationId = 2;
  mockFetch();
});

// ===========================================================================
// THE NOTE (MS-1-1)
// ===========================================================================

describe("the Note", () => {
  it("is ONE optional field, with its audience; the reference field and Additional Notes are gone", () => {
    renderDialog();

    expect(noteField()).toBeInTheDocument();
    expect(noteField()).toHaveAttribute("maxLength", "2000");
    expect(noteField()).toHaveAccessibleDescription("Seen by admins and by you.");
    expect(screen.getByText("Seen by admins and by you.")).toBeInTheDocument();
    expect(screen.queryByText(/Order\/Reference Number/i)).toBeNull();
    expect(screen.queryByText(/Additional Notes/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/PO-2024-001/)).toBeNull();
    // Exactly two fields: the quantity (a number input) and the Note.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
    expect(screen.getAllByRole("textbox")).toEqual([noteField()]);
  });

  it("the note is in the body as `notes`, and there is NO `orderNumber` key", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(quantityField(), "12");
    await user.type(noteField(), "PO 4471 from the March order");
    await user.click(actionButton());

    await waitFor(() => expect(stockInBodies()).toHaveLength(1));
    expect(stockInBodies()[0]).toEqual({
      productId: 42,
      locationId: 2,
      quantity: 12,
      notes: "PO 4471 from the March order",
    });
    expect(stockInBodies()[0]).not.toHaveProperty("orderNumber");
  });

  it("an empty (or blank) note sends no `notes` key at all", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(quantityField(), "3");
    await user.type(noteField(), "   ");
    await user.click(actionButton());

    await waitFor(() => expect(stockInBodies()).toHaveLength(1));
    expect(stockInBodies()[0]).toEqual({ productId: 42, locationId: 2, quantity: 3 });
  });

  it("the note is trimmed before it is sent", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(quantityField(), "3");
    await user.type(noteField(), "  batch 7  ");
    await user.click(actionButton());

    await waitFor(() => expect(stockInBodies()).toHaveLength(1));
    expect(stockInBodies()[0]).toEqual({ productId: 42, locationId: 2, quantity: 3, notes: "batch 7" });
  });
});

// ===========================================================================
// MOUNTED PER OPEN — the typed-state arm (MS-1-5; the page arm is
// inventory-page.test.tsx)
// ===========================================================================

describe("every open is a fresh draft", () => {
  it("typed on A → remount for B → empty", async () => {
    const user = userEvent.setup();
    const first = renderDialog(PRODUCT_A);
    await user.type(quantityField(), "12");
    await user.type(noteField(), "for A only");
    expect(quantityField()).toHaveValue(12);
    first.unmount();

    renderDialog(PRODUCT_B);
    expect(screen.getByText("BPC 5mg")).toBeInTheDocument();
    expect(quantityField()).toHaveValue(null);
    expect(noteField()).toHaveValue("");
    expect(actionButton()).toHaveTextContent("Add 0 Units");
    expect(actionButton()).toBeDisabled();
  });
});

// ===========================================================================
// THE LATCH (M-a.1): one stock-in per tap, no dismissal while it is in flight
// ===========================================================================

describe("a stock-in in flight cannot be dismissed", () => {
  it("Escape while busy does not close it; the answer does, through the host's raw callback", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onSuccess } = renderDialog();
    await user.type(quantityField(), "5");

    const release = holdNextStockIn();
    await user.click(actionButton());
    await waitFor(() => expect(actionButton()).toHaveTextContent("Adding Stock..."));
    expect(cancelButton()).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(toast.success as jest.Mock).toHaveBeenCalledWith("Added 5 units to AOD 2mg");
  });

  it.each<[string, () => void]>([
    ["Escape", () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })],
    ["Cancel", () => fireEvent.click(cancelButton())],
    ["the X", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
  ])("%s in the instant after the tap (before any render) is dropped", async (_how, dismiss) => {
    const user = userEvent.setup();
    const { onOpenChange, onSuccess } = renderDialog();
    await user.type(quantityField(), "5");

    const release = holdNextStockIn();
    act(() => {
      fireEvent.click(actionButton());
      expect(actionButton()).toHaveTextContent("Add 5 Units");
      dismiss();
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it("a double tap sends ONE stock-in", async () => {
    const user = userEvent.setup();
    const { onSuccess } = renderDialog();
    await user.type(quantityField(), "5");

    const release = holdNextStockIn();
    act(() => {
      fireEvent.click(actionButton());
      fireEvent.click(actionButton());
    });
    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(stockInBodies()).toHaveLength(1);
  });

  it("while busy the form is frozen (the fieldset)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(quantityField(), "5");

    const release = holdNextStockIn();
    await user.click(actionButton());
    await waitFor(() => expect(actionButton()).toHaveTextContent("Adding Stock..."));
    const fieldset = screen.getByRole("dialog").querySelector("fieldset");
    expect(fieldset).toHaveAttribute("disabled");
    expect(fieldset).toHaveClass("min-w-0");
    expect(quantityField()).toBeDisabled();
    expect(noteField()).toBeDisabled();
    expect(actionButton()).toBeDisabled();

    await act(async () => release());
    await waitFor(() => expect(toast.success as jest.Mock).toHaveBeenCalled());
  });

  it("a FAILED stock-in keeps the dialog open with the draft, and releases the latch", async () => {
    const user = userEvent.setup();
    stockInAnswer = { status: 500, body: { error: "Something broke" } };
    const { onOpenChange, onSuccess } = renderDialog();
    await user.type(quantityField(), "5");
    await user.type(noteField(), "kept");

    await user.click(actionButton());
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(quantityField()).toHaveValue(5);
    expect(noteField()).toHaveValue("kept");

    // Released: the action sends again, and Cancel closes.
    await waitFor(() => expect(actionButton()).toBeEnabled());
    await user.click(actionButton());
    await waitFor(() => expect(stockInBodies()).toHaveLength(2));
    await waitFor(() => expect(cancelButton()).toBeEnabled());
    await user.click(cancelButton());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });
});

// ===========================================================================
// FR-R1 (4): the current-stock chip — the adjust dialog's four states, and no
// projection from stock that is not known (CR-OC-2, CR-G1-7)
// ===========================================================================

describe("the current-stock chip", () => {
  const chip = () => screen.getByTestId("stock-in-stock");
  const newTotal = () => screen.queryByText(/^New:/);

  it("`Reading stock…` while the read is in flight — and no new total, even with a quantity", () => {
    stockRead = "hang";
    renderDialog();
    fireEvent.change(quantityField(), { target: { value: "5" } });
    expect(chip()).toHaveTextContent("Reading stock…");
    expect(chip()).not.toHaveTextContent(/\d/);
    expect(newTotal()).toBeNull();
  });

  it("`{n} units` once the read answers, and the new total from it", async () => {
    renderDialog();
    await waitFor(() => expect(chip()).toHaveTextContent("7 units"));
    expect(newTotal()).toBeNull();
    fireEvent.change(quantityField(), { target: { value: "5" } });
    expect(newTotal()).toHaveTextContent("New: 12");
  });

  it("`1 unit` for one", async () => {
    stockRead = 1;
    renderDialog();
    await waitFor(() => expect(chip()).toHaveTextContent(/^1 unit$/));
  });

  it("`0 units` is a KNOWN zero — the new total is drawn from it", async () => {
    stockRead = 0;
    renderDialog();
    await waitFor(() => expect(chip()).toHaveTextContent("0 units"));
    fireEvent.change(quantityField(), { target: { value: "5" } });
    expect(newTotal()).toHaveTextContent("New: 5");
  });

  // FR-R2 (9), QA-10a: a stock-in is not checked against the stock on save, so
  // the failure says only what happened.
  it("a failed read: `Couldn't read current stock.`, never 0, and no new total", async () => {
    stockRead = "error";
    renderDialog();
    fireEvent.change(quantityField(), { target: { value: "5" } });
    await waitFor(() => expect(chip()).toHaveTextContent(/^Couldn't read current stock\.$/));
    expect(chip()).not.toHaveTextContent(/\d/);
    expect(newTotal()).toBeNull();
  });

  it("no location: `No location selected.`, no read, and no new total", () => {
    mockLocation.selectedLocationId = null;
    const fetchFn = mockFetch();
    renderDialog();
    fireEvent.change(quantityField(), { target: { value: "5" } });
    expect(chip()).toHaveTextContent("No location selected.");
    expect(newTotal()).toBeNull();
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes("/api/inventory/product/"))).toHaveLength(0);
  });
});
