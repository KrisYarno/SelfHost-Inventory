/** @jest-environment jsdom */
/**
 * THE ADJUST DIALOG (reconciliation Part 2, pack § P2-B3-1R, R-b.2; the suite
 * REWRITTEN under the new labels, R-b pins).
 *
 * Phone first: it opens on Remove; one order number field under the `order`
 * chip; one optional Note; a sticky footer that says what the tap will do; the
 * blockers say why it can't; and the hosts mount it PER OPEN, so every open is
 * an empty draft. Pinned here, against a host shaped like the pages (rendered
 * only while open for a product; the product nulled on close):
 *
 *   - the defaults, the stock chip, the quantity field;
 *   - hide, don't clear (the body reads the capture only under Remove + order);
 *   - the body per path, and never an implicit pick;
 *   - the blockers, and dismissal (a non-empty draft survives Escape and a tap
 *     outside; Cancel and the X discard; a failed save keeps the draft);
 *   - the FR4 latch, re-expressed one-for-one (§ P2-B3-1R R-b pins);
 *   - the rejected pick's recovery; the footer; each toast byte for byte.
 *
 * The order field's own behaviour is pinned in `order-number-field.test.tsx`;
 * here its search answers on cue through the mocked hook.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));

const mockLocation: { selectedLocationId: number | null; locations: Array<{ id: number; name: string }> } = {
  selectedLocationId: 2,
  locations: [{ id: 2, name: "Office" }],
};
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => mockLocation,
}));

const useOrderSearchMock = jest.fn();
jest.mock("@/hooks/use-order-search", () => ({
  useOrderSearch: (q: string, opts?: unknown) => useOrderSearchMock(q, opts),
}));

const toastPlain = jest.fn();
const toastSuccess = jest.fn();
const toastWarning = jest.fn();
const toastError = jest.fn();
jest.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => toastPlain(...a), {
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    error: (...a: unknown[]) => toastError(...a),
    message: jest.fn(),
  }),
}));

import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";
import { SELECTED_ORDER_REJECTED_SENTENCE } from "@/lib/orders/order-capture-sentences";
import type { DialogProduct } from "@/types/inventory";

type User = ReturnType<typeof userEvent.setup>;

const PRODUCT_A = { id: 42, name: "AOD 2mg" };
const PRODUCT_B = { id: 43, name: "BPC 5mg" };
const THIS_YEAR = new Date().getFullYear();

const ORDER_2044 = {
  id: "ord-2",
  orderNumber: "2044",
  platform: "woocommerce",
  internalStatus: "PROCESSING",
  externalCreatedAt: `${THIS_YEAR}-08-19T12:00:00.000Z`,
  itemCount: 4,
  store: "North Shop",
  thisProduct: { orderedUnits: 3, uncheckedLines: 0 },
};

/** What the stock read answers (per product id), or a failure. */
let stockAnswer: number | "error";
/** What the adjust route answers on the next submit. */
let adjustAnswer: { status: number; body: Record<string, unknown> };
/** The order search's rows (the mocked hook filters them by "contains"). */
let searchOrders: Array<typeof ORDER_2044>;
let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // The receiving prompt shows once per session; every test is a new session.
  window.sessionStorage.clear();
  mockLocation.selectedLocationId = 2;
  mockLocation.locations = [{ id: 2, name: "Office" }];
  stockAnswer = 40;
  searchOrders = [ORDER_2044];
  useOrderSearchMock.mockImplementation((q: string) => {
    if (q === "") return { status: "pending", data: undefined, error: null };
    const orders = searchOrders.filter((o) => o.orderNumber.includes(q));
    return {
      status: "success",
      data: { orders, moreCount: 0, exactCount: orders.filter((o) => o.orderNumber === q).length },
      error: null,
    };
  });
  adjustAnswer = {
    status: 200,
    body: { success: true, log: { id: 1, orderRecordId: null }, newVersion: 2, batchId: "b-1" },
  };
  fetchMock = jest.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/inventory/product/")) {
      if (stockAnswer === "error") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return { ok: true, json: async () => ({ currentQuantity: stockAnswer }) } as unknown as Response;
    }
    return {
      ok: adjustAnswer.status < 400,
      status: adjustAnswer.status,
      json: async () => adjustAnswer.body,
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

/**
 * The pages' shape (§ P2-B3-1R R-b.2 / M-a.3): the dialog is rendered ONLY
 * while it is open for a product, and the product is nulled when it closes.
 */
function PerOpenHost({
  onOpenChange,
  onSuccess,
  children,
}: {
  onOpenChange?: (open: boolean) => void;
  onSuccess?: () => void;
  children?: React.ReactNode;
}) {
  const [product, setProduct] = React.useState<DialogProduct | null>({ ...PRODUCT_A });
  const [open, setOpen] = React.useState(true);
  const openFor = (next: DialogProduct) => {
    setProduct({ ...next });
    setOpen(true);
  };
  return (
    <>
      <button type="button" onClick={() => openFor(PRODUCT_A)}>Adjust A</button>
      <button type="button" onClick={() => openFor(PRODUCT_B)}>Adjust B</button>
      <button type="button">Beside the dialog</button>
      {product && open && (
        <QuickAdjustDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange?.(next);
            setOpen(next);
            if (!next) setProduct(null);
          }}
          product={product}
          onSuccess={onSuccess ?? (() => {})}
        />
      )}
      {children}
    </>
  );
}

function renderHost(props: { onOpenChange?: (open: boolean) => void; onSuccess?: () => void } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PerOpenHost {...props} />
    </QueryClientProvider>,
  );
  return client;
}

const dialog = () => screen.getByRole("dialog");
const stockChip = () => screen.getByTestId("adjust-stock");
const quantityField = () => screen.getByLabelText(/^Units to (remove|add)$/);
const chipGroup = () => within(screen.getByRole("radiogroup", { name: "What was this for?" }));
const tapChip = (user: User, name: string) => user.click(chipGroup().getByRole("radio", { name }));
const tapDirection = (user: User, name: "Remove" | "Add") => user.click(screen.getByRole("button", { name }));
const orderField = () => screen.getByRole("textbox", { name: "Order number" });
const noteField = () => screen.getByLabelText("Note (optional)");
const footer = () => screen.getByTestId("adjust-footer");
const actionButton = () => within(footer()).getAllByRole("button")[1];
const cancelButton = () => within(footer()).getByRole("button", { name: "Cancel" });
const summary = () => screen.getByTestId("adjust-summary").textContent;
const orderLine = () => screen.queryByTestId("adjust-order-line")?.textContent ?? null;
const message = () => screen.queryByTestId("adjust-message")?.textContent ?? null;
const adjustCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/inventory/adjust");
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;

async function stockReady(text = "40 units") {
  await waitFor(() => expect(stockChip()).toHaveTextContent(text));
}

/** The host, the stock read, and a quantity of 3 (on the default Remove). */
async function ready(user: User, props: Parameters<typeof renderHost>[0] = {}) {
  renderHost(props);
  await stockReady();
  await user.type(quantityField(), "3");
}

/** The `order` chip, and the field it brings. */
async function intoOrder(user: User) {
  await tapChip(user, "Order");
  await waitFor(() => expect(orderField()).toBeInTheDocument());
}

/** Type into the order field and wait for its answer to settle. */
async function typeOrder(user: User, text: string) {
  await user.type(orderField(), text);
  await waitFor(() => expect(screen.getByTestId("order-number-status")).not.toHaveTextContent("Checking…"));
}

async function pickOrder(user: User) {
  await typeOrder(user, "2044");
  await user.click(screen.getByRole("button", { name: "Use this order" }));
  expect(screen.getByTestId("order-number-picked")).toBeInTheDocument();
}

/** Tap the action, wait for the POST, and hand back the body it carried. */
async function submit(user: User): Promise<Record<string, unknown>> {
  const before = adjustCalls().length;
  await user.click(actionButton());
  await waitFor(() => expect(adjustCalls().length).toBe(before + 1));
  return bodyOf(adjustCalls()[before]);
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

// ===========================================================================
// THE DEFAULTS
// ===========================================================================

describe("it opens on Remove", () => {
  it("the title, no description, Remove selected, the remove label, and the chip", async () => {
    renderHost();
    await stockReady();

    expect(within(dialog()).getByRole("heading", { name: "Adjust stock" })).toBeInTheDocument();
    expect(dialog()).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("button", { name: "Remove" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass("min-h-[44px]");
    expect(screen.getByRole("button", { name: "Add" })).toHaveClass("min-h-[44px]");
    expect(quantityField()).toHaveAccessibleName("Units to remove");
    expect(chipGroup().getAllByRole("radio")).toHaveLength(3);
    for (const radio of chipGroup().getAllByRole("radio")) expect(radio).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/receiving a shipment\?/i)).toBeNull();
    // The Reason is gone; the Note is optional.
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
    expect(noteField()).toBeInTheDocument();
  });

  it("the content caps at 85dvh (tailwind-merge drops the base 85vh); the footer carries the sticky classes exactly", async () => {
    renderHost();
    await stockReady();
    expect(dialog()).toHaveClass("max-h-[85dvh]");
    expect(dialog().className).not.toContain("max-h-[85vh]");
    expect(footer().className).toBe(
      "sticky bottom-0 -mx-4 px-4 sm:-mx-6 sm:px-6 -mb-4 pb-4 sm:-mb-6 sm:pb-6 bg-background border-t pt-3",
    );
  });

  it("the chip's row layout shows the hint for the selected option only", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    expect(screen.queryByTestId("intent-chip-hint")).toBeNull();
    expect(screen.queryByText("Went out against a customer order")).toBeNull();
    await tapChip(user, "Damage / loss");
    expect(screen.getByTestId("intent-chip-hint").textContent).toBe(
      "Damaged, expired or otherwise lost — counts as shrinkage",
    );
    expect(screen.queryByText("Not classified — recorded as-is")).toBeNull();
  });
});

// ===========================================================================
// THE STOCK CHIP AND THE PREVIEW
// ===========================================================================

describe("the stock chip", () => {
  it("`Reading stock…` until the read answers, then `{n} units` (the per-location read, never a passed-in total)", async () => {
    let resolveQty!: (v: unknown) => void;
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes("/api/inventory/product/")) return new Promise((r) => (resolveQty = r));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    renderHost();
    expect(stockChip()).toHaveTextContent("Reading stock…");
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/inventory/product/42?locationId=2&limit=1");
    resolveQty({ ok: true, json: async () => ({ currentQuantity: 7 }) });
    await stockReady("7 units");
  });

  it("`1 unit` for one", async () => {
    stockAnswer = 1;
    renderHost();
    await stockReady("1 unit");
    expect(stockChip().textContent).not.toContain("1 units");
  });

  it("a failed read says it will be checked on save, and never reads as 0", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    stockAnswer = "error";
    renderHost();
    await waitFor(() =>
      expect(stockChip()).toHaveTextContent(
        "Couldn't read current stock — it will be checked when you save.",
      ),
    );
    await user.type(quantityField(), "50");
    // Unknown stock blocks nothing and computes nothing: the server decides.
    expect(screen.queryByTestId("quantity-preview")).toBeNull();
    expect(message()).toBeNull();
    expect(actionButton()).toBeEnabled();
  });

  it("no location: `No location selected.`, and the blocker says how to fix it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockLocation.selectedLocationId = null;
    renderHost();
    expect(stockChip()).toHaveTextContent("No location selected.");
    await user.type(quantityField(), "3");
    expect(message()).toBe("Close this and choose a location at the top of the page.");
    expect(actionButton()).toBeDisabled();
    expect(summary()).toBe("Remove 3 units of AOD 2mg");
    // No location, no stock read.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/inventory/product/"))).toBe(false);
  });

  it("the preview: `After this, {location} will have {n} unit(s).` only with known stock and a quantity", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    expect(screen.queryByTestId("quantity-preview")).toBeNull();

    await user.type(quantityField(), "3");
    expect(screen.getByTestId("quantity-preview").textContent).toBe("After this, Office will have 37 units.");

    await tapDirection(user, "Add");
    expect(screen.getByTestId("quantity-preview").textContent).toBe("After this, Office will have 43 units.");

    await user.clear(quantityField());
    await user.type(quantityField(), "0");
    expect(screen.queryByTestId("quantity-preview")).toBeNull();
  });

  it("the preview says `1 unit` for one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    stockAnswer = 4;
    renderHost();
    await stockReady("4 units");
    await user.type(quantityField(), "3");
    expect(screen.getByTestId("quantity-preview").textContent).toBe("After this, Office will have 1 unit.");
  });
});

// ===========================================================================
// THE QUANTITY FIELD
// ===========================================================================

describe("the quantity field", () => {
  it("is a numeric text field of at most 6 characters", async () => {
    renderHost();
    expect(quantityField()).toHaveAttribute("type", "text");
    expect(quantityField()).toHaveAttribute("inputmode", "numeric");
    expect(quantityField()).toHaveAttribute("maxlength", "6");
  });

  it("REFUSES a non-digit keystroke (value unchanged) and says `Whole units only.` until blur", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await user.type(quantityField(), "3");
    await user.type(quantityField(), ".");
    expect(quantityField()).toHaveValue("3");
    const refusal = screen.getByTestId("quantity-refused");
    expect(refusal.textContent).toBe("Whole units only.");
    expect(refusal).toHaveAttribute("role", "status");

    // It persists through a later valid keystroke...
    await user.type(quantityField(), "4");
    expect(quantityField()).toHaveValue("34");
    expect(screen.getByTestId("quantity-refused")).toBeInTheDocument();

    // ...until blur.
    fireEvent.blur(quantityField());
    expect(screen.queryByTestId("quantity-refused")).toBeNull();
  });

  it("the message also goes when the field is emptied", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await user.type(quantityField(), "3a");
    expect(quantityField()).toHaveValue("3");
    expect(screen.getByTestId("quantity-refused")).toBeInTheDocument();
    await user.type(quantityField(), "{Backspace}");
    expect(quantityField()).toHaveValue("");
    expect(screen.queryByTestId("quantity-refused")).toBeNull();
  });

  it.each([["-"], ["e"], ["1.5"], ["2,5"]])("a paste of %j is refused whole", async (pasted) => {
    renderHost();
    fireEvent.change(quantityField(), { target: { value: pasted } });
    expect(quantityField()).toHaveValue("");
    expect(screen.getByTestId("quantity-refused")).toBeInTheDocument();
  });

  it("leading zeros are stripped as typed; a lone 0 stays and blocks", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    await user.type(quantityField(), "007");
    expect(quantityField()).toHaveValue("7");
    await user.clear(quantityField());
    await user.type(quantityField(), "0");
    expect(quantityField()).toHaveValue("0");
    expect(message()).toBe("Enter how many units.");
    expect(actionButton()).toBeDisabled();
  });

  it("− on blank does nothing; + on blank gives 1; − steps down to 1 and no further; both are 44 px", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    const minus = screen.getByRole("button", { name: "Decrease quantity" });
    const plus = screen.getByRole("button", { name: "Increase quantity" });
    expect(minus).toHaveClass("h-11", "w-11");
    expect(plus).toHaveClass("h-11", "w-11");

    fireEvent.click(minus);
    expect(quantityField()).toHaveValue("");
    await user.click(plus);
    expect(quantityField()).toHaveValue("1");
    await user.click(plus);
    await user.click(plus);
    expect(quantityField()).toHaveValue("3");
    await user.click(minus);
    await user.click(minus);
    expect(quantityField()).toHaveValue("1");
    fireEvent.click(minus);
    expect(quantityField()).toHaveValue("1");
  });

  it("the label follows the direction", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    expect(quantityField()).toHaveAccessibleName("Units to remove");
    await tapDirection(user, "Add");
    expect(quantityField()).toHaveAccessibleName("Units to add");
  });
});

// ===========================================================================
// WHAT SHOWS WHERE — and HIDE, DON'T CLEAR (R107-OC-16 / G1-13, R108-OC-6)
// ===========================================================================

describe("what shows where", () => {
  it("the chip only on Remove; the order field only on Remove + Order; the receiving prompt only on Add", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    expect(screen.queryByRole("textbox", { name: "Order number" })).toBeNull();

    await tapChip(user, "Damage / loss");
    expect(screen.queryByRole("textbox", { name: "Order number" })).toBeNull();
    await tapChip(user, "Other");
    expect(screen.queryByRole("textbox", { name: "Order number" })).toBeNull();
    await intoOrder(user);

    await tapDirection(user, "Add");
    expect(screen.queryByRole("radiogroup", { name: "What was this for?" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Order number" })).toBeNull();
    expect(screen.getByText(/receiving a shipment\?/i)).toBeInTheDocument();
  });

  it("with an empty order field, the helper says a number not in the app is still saved", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    expect(screen.getByTestId("order-number-helper").textContent).toBe(
      "If the order isn't in the app yet, type its number anyway — it's saved so an admin can link it later.",
    );
  });
});

describe("hide, don't clear", () => {
  it("Remove → Add → Remove keeps the typed number; the Add body carries no identity and no intent", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "9999");

    await tapDirection(user, "Add");
    await tapDirection(user, "Remove");
    expect(orderField()).toHaveValue("9999");
    expect(chipGroup().getByRole("radio", { name: "Order" })).toHaveAttribute("aria-checked", "true");

    await tapDirection(user, "Add");
    const body = await submit(user);
    expect(body).toMatchObject({ productId: 42, locationId: 2, delta: 3 });
    expect("intent" in body).toBe(false);
    expect("orderReference" in body).toBe(false);
    expect("selectedExternalOrderId" in body).toBe(false);
  });

  it("a PICK survives Remove → Add → Remove, and Order → Damage → Order", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);

    await tapDirection(user, "Add");
    await tapDirection(user, "Remove");
    expect(screen.getByTestId("order-number-picked")).toHaveTextContent("Order 2044 · North Shop");

    await tapChip(user, "Damage / loss");
    expect(screen.queryByTestId("order-number-picked")).toBeNull();
    await tapChip(user, "Order");
    expect(screen.getByTestId("order-number-picked")).toHaveTextContent("Order 2044 · North Shop");
  });

  it("Order → Other: the hidden number is not sent; the body says `other` only", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "9999");
    await tapChip(user, "Other");

    const body = await submit(user);
    expect(body).toMatchObject({ delta: -3, intent: "other" });
    expect("orderReference" in body).toBe(false);
    expect("selectedExternalOrderId" in body).toBe(false);
  });

  it("Order → Damage after a pick: the hidden pick is not sent", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);
    await tapChip(user, "Damage / loss");

    const body = await submit(user);
    expect(body.intent).toBe("damage-loss");
    expect("orderReference" in body).toBe(false);
    expect("selectedExternalOrderId" in body).toBe(false);
  });

  it("ill-shaped text, then Add: the action is ENABLED and the body carries no identity (R108-OC-6)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await user.type(orderField(), "20a4");
    expect(actionButton()).toBeDisabled();

    await tapDirection(user, "Add");
    expect(message()).toBeNull();
    expect(actionButton()).toBeEnabled();
    const body = await submit(user);
    expect(body).toMatchObject({ delta: 3 });
    expect("orderReference" in body).toBe(false);
    expect("selectedExternalOrderId" in body).toBe(false);
    expect("intent" in body).toBe(false);
  });

  it("ill-shaped text, then damage-loss: the action is ENABLED and the body carries no identity (R108-OC-6)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await user.type(orderField(), "20a4");
    expect(actionButton()).toBeDisabled();

    await tapChip(user, "Damage / loss");
    expect(message()).toBeNull();
    expect(actionButton()).toBeEnabled();
    const body = await submit(user);
    expect(body).toMatchObject({ delta: -3, intent: "damage-loss" });
    expect("orderReference" in body).toBe(false);
    expect("selectedExternalOrderId" in body).toBe(false);
  });
});

// ===========================================================================
// THE BODY
// ===========================================================================

describe("the body", () => {
  it("a PICKED order sends its id only — no `orderReference`, though the field held the number", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);

    const body = await submit(user);
    expect(body).toMatchObject({ productId: 42, locationId: 2, delta: -3, intent: "order" });
    expect(body.selectedExternalOrderId).toBe("ord-2");
    expect("orderReference" in body).toBe(false);
  });

  it("a FOUND but untapped exact match sends `orderReference` and no id (seeing is not picking)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "2044");
    expect(screen.getByRole("button", { name: "Use this order" })).toBeInTheDocument();

    const body = await submit(user);
    expect(body.orderReference).toBe("2044");
    expect("selectedExternalOrderId" in body).toBe(false);
  });

  it("no implicit pick on blur, Tab or Enter, or for a single result", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "2044");
    // One result, found: still not a pick.
    await user.keyboard("{Enter}");
    await user.tab();
    fireEvent.blur(orderField());
    expect(screen.queryByTestId("order-number-picked")).toBeNull();
    // Enter in the field sent nothing.
    expect(adjustCalls()).toHaveLength(0);

    const body = await submit(user);
    expect(body.orderReference).toBe("2044");
    expect("selectedExternalOrderId" in body).toBe(false);
  });

  it("a number not in the app is sent as typed — normalised in view (`# 99 99` → `9999`)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await user.type(orderField(), "# 99 99");
    expect(orderField()).toHaveValue("9999");

    const body = await submit(user);
    expect(body.orderReference).toBe("9999");
    expect("selectedExternalOrderId" in body).toBe(false);
  });

  it("`order` with nothing typed sends the intent and no identity keys", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    const body = await submit(user);
    expect(body.intent).toBe("order");
    expect("orderReference" in body).toBe(false);
    expect("selectedExternalOrderId" in body).toBe(false);
  });

  it("an untapped chip sends NO intent; `reason` is never sent; the Note rides as `notes`", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await user.type(noteField(), "  box was crushed  ");

    const body = await submit(user);
    expect(body).toEqual({ productId: 42, locationId: 2, delta: -3, notes: "box was crushed" });
    expect("reason" in body).toBe(false);
    expect("intent" in body).toBe(false);
  });

  it("a whitespace-only Note is not sent", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await user.type(noteField(), "   ");
    const body = await submit(user);
    expect("notes" in body).toBe(false);
  });

  it("the Note: `Note (optional)`, 2000 characters, its placeholder and `Seen by admins and by you.`", async () => {
    renderHost();
    expect(noteField().tagName).toBe("TEXTAREA");
    expect(noteField()).toHaveAttribute("maxlength", "2000");
    expect(noteField()).toHaveAttribute("placeholder", "Anything someone reviewing this should know");
    expect(noteField()).toHaveAccessibleDescription("Seen by admins and by you.");
  });
});

// ===========================================================================
// THE BLOCKERS
// ===========================================================================

describe("the blockers", () => {
  it("an empty quantity: `Enter how many units.` and the action is dead", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    expect(message()).toBe("Enter how many units.");
    expect(actionButton()).toBeDisabled();
    await user.click(actionButton());
    expect(adjustCalls()).toHaveLength(0);
  });

  it("Remove beyond KNOWN stock: `You can't remove more than the {n} unit(s) on record at {location}.`", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    await user.type(quantityField(), "41");
    expect(message()).toBe("You can't remove more than the 40 units on record at Office.");
    expect(actionButton()).toBeDisabled();

    // The same quantity as an Add is fine.
    await tapDirection(user, "Add");
    expect(message()).toBeNull();
    expect(actionButton()).toBeEnabled();
  });

  it("`1 unit` in the stock blocker", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    stockAnswer = 1;
    renderHost();
    await stockReady("1 unit");
    await user.type(quantityField(), "2");
    expect(message()).toBe("You can't remove more than the 1 unit on record at Office.");
  });

  it("ill-shaped order text with nothing picked blocks until it is fixed, or cleared in one tap", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await user.type(orderField(), "20a4");

    expect(message()).toBe("Order number: digits only — fix it or clear it.");
    expect(screen.getByTestId("order-number-shape").textContent).toBe("Order numbers are 1–20 digits.");
    expect(actionButton()).toBeDisabled();
    await user.click(actionButton());
    expect(adjustCalls()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(orderField()).toHaveValue("");
    expect(message()).toBeNull();
    expect(actionButton()).toBeEnabled();
  });

  it("more than twenty digits fails the same bar", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await user.type(orderField(), "1".repeat(21));
    expect(message()).toBe("Order number: digits only — fix it or clear it.");
    expect(actionButton()).toBeDisabled();
  });

  it("a PICKED order never blocks on the shape, even when its number is not digits", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    searchOrders = [{ ...ORDER_2044, id: "ord-wc", orderNumber: "WC-2044" }];
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "2044");
    await user.click(screen.getByTestId("order-number-row-ord-wc"));
    expect(message()).toBeNull();
    expect(actionButton()).toBeEnabled();
    const body = await submit(user);
    expect(body.selectedExternalOrderId).toBe("ord-wc");
  });

  it("only the FIRST blocker is shown", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockLocation.selectedLocationId = null;
    renderHost();
    expect(message()).toBe("Close this and choose a location at the top of the page.");
    await user.type(quantityField(), "3");
    expect(message()).toBe("Close this and choose a location at the top of the page.");
    expect(screen.getAllByTestId("adjust-message")).toHaveLength(1);
  });
});

// ===========================================================================
// DISMISSAL (the idle arms; FR4's `:647-656` SPLIT)
// ===========================================================================

describe("dismissal while idle", () => {
  async function readyEmpty(onOpenChange: jest.Mock) {
    renderHost({ onOpenChange });
    await stockReady();
  }

  const ESCAPE = (user: User) => user.keyboard("{Escape}");
  // Outside the modal, so the accessibility tree hides it.
  const OUTSIDE = (user: User) =>
    user.click(screen.getByRole("button", { name: "Beside the dialog", hidden: true }));

  it.each([
    ["Escape", ESCAPE],
    ["a click outside", OUTSIDE],
  ])("%s closes an EMPTY draft", async (_how, dismiss) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    await readyEmpty(onOpenChange);

    await dismiss(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  const DRAFTS: Array<[string, (user: User) => Promise<void>]> = [
    ["a quantity", async (user) => user.type(quantityField(), "3")],
    ["a chip", async (user) => tapChip(user, "Other")],
    ["a note", async (user) => user.type(noteField(), "x")],
    [
      "order text",
      async (user) => {
        await intoOrder(user);
        await user.type(orderField(), "9");
        await tapChip(user, "Other");
      },
    ],
  ];

  for (const [how, dismiss] of [
    ["Escape", ESCAPE],
    ["a click outside", OUTSIDE],
  ] as const) {
    it.each(DRAFTS)(`${how} does NOT close a draft with %s`, async (_label, fill) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const onOpenChange = jest.fn();
      await readyEmpty(onOpenChange);
      await fill(user);

      await dismiss(user);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  }

  it("Escape does NOT close a draft holding only a pick", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    await readyEmpty(onOpenChange);
    await intoOrder(user);
    await pickOrder(user);
    await ESCAPE(user);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("order-number-picked")).toBeInTheDocument();
  });

  it.each([
    ["the X", (user: User) => user.click(screen.getByRole("button", { name: "Close" }))],
    ["Cancel", (user: User) => user.click(cancelButton())],
  ])("%s closes an idle NON-EMPTY draft and discards it (the next open is empty)", async (_how, dismiss) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    await readyEmpty(onOpenChange);
    await user.type(quantityField(), "3");
    await intoOrder(user);
    await user.type(orderField(), "9999");
    await user.type(noteField(), "n");

    await dismiss(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(adjustCalls()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Adjust A" }));
    await stockReady();
    expect(quantityField()).toHaveValue("");
    expect(noteField()).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Order number" })).toBeNull();
  });

  it("a FAILED save keeps the dialog open with the draft", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    adjustAnswer = { status: 500, body: { error: "Something broke" } };
    await readyEmpty(onOpenChange);
    await user.type(quantityField(), "3");
    await intoOrder(user);
    await typeOrder(user, "9999");
    await user.type(noteField(), "kept");

    await submit(user);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Something broke"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(quantityField()).toHaveValue("3");
    expect(orderField()).toHaveValue("9999");
    expect(noteField()).toHaveValue("kept");
  });
});

// ===========================================================================
// A SAVE IN FLIGHT CANNOT BE DISMISSED (B3-1 FR3/FR4 — `:586-731`,
// re-expressed one-for-one through the shared latch, § P2-B3-1R M-a.1).
// ===========================================================================

describe("a save in flight cannot be dismissed", () => {
  async function readyGuarded(user: User, onOpenChange: jest.Mock) {
    renderHost({ onOpenChange });
    await stockReady();
    await user.type(quantityField(), "3");
  }

  const DISMISSALS: Array<[string, (user: User) => Promise<void>]> = [
    ["Escape", (user) => user.keyboard("{Escape}")],
    ["a click outside", (user) => user.click(screen.getByRole("button", { name: "Beside the dialog", hidden: true }))],
    ["the X", (user) => user.click(screen.getByRole("button", { name: "Close" }))],
    // Disabled while saving (the fieldset and its own prop); a click is dropped.
    ["Cancel", async () => void fireEvent.click(cancelButton())],
  ];

  it.each(DISMISSALS)("%s does not close it while the request is in flight; the answer does", async (_how, dismiss) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    await readyGuarded(user, onOpenChange);

    const release = holdNextAdjust();
    await user.click(actionButton());
    await waitFor(() => expect(actionButton()).toHaveTextContent("Removing 3 units…"));
    expect(cancelButton()).toBeDisabled();

    await dismiss(user);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(actionButton()).toHaveTextContent("Removing 3 units…");

    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(toastSuccess).toHaveBeenCalledWith("Removed 3 units of AOD 2mg at Office.");
  });

  it("while saving the WHOLE form is frozen, and the label reads `Removing 3 units…` / `Adding 3 units…`", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    await user.type(quantityField(), "3");
    await tapDirection(user, "Add");

    const release = holdNextAdjust();
    await user.click(actionButton());
    await waitFor(() => expect(actionButton()).toHaveTextContent("Adding 3 units…"));
    const fieldset = dialog().querySelector("fieldset");
    expect(fieldset).toHaveAttribute("disabled");
    expect(fieldset).toHaveClass("min-w-0");
    expect(quantityField()).toBeDisabled();
    expect(noteField()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(actionButton()).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // B3-1 FD3-1: the rendered state lags the request, so a guard that reads only
  // the render admits a dismissal (or a second tap) in the instant after the
  // tap. The latch's synchronous ref closes it. M-a's one-`act` form: the tap,
  // the not-yet-rendered label, and the dismissal in ONE act — the instant that
  // remains. (Escape is ALSO held by the non-empty-draft rule, so its arm stays
  // green without the latch; Cancel and the X are held by the latch alone.)
  const INSTANT_DISMISSALS: Array<[string, () => void]> = [
    ["Escape", () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })],
    ["Cancel", () => fireEvent.click(cancelButton())],
    ["the X", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
  ];

  it.each(INSTANT_DISMISSALS)(
    "%s in the instant before \"Removing 3 units…\" renders does not close it (FD3-1)",
    async (_how, dismiss) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const onOpenChange = jest.fn();
      await readyGuarded(user, onOpenChange);

      const release = holdNextAdjust();
      act(() => {
        fireEvent.click(actionButton());
        // The window is real: the request has started, the render has not caught up.
        expect(actionButton()).toHaveTextContent("Remove 3 units");
        dismiss();
      });
      expect(onOpenChange).not.toHaveBeenCalled();

      await waitFor(() => expect(adjustCalls()).toHaveLength(1));
      expect(onOpenChange).not.toHaveBeenCalled();
      release();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onOpenChange.mock.calls).toEqual([[false]]);
      expect(adjustCalls()).toHaveLength(1);
    },
  );

  it("a second tap in that instant sends ONE request, never two (FD3-1)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    await readyGuarded(user, onOpenChange);

    const release = holdNextAdjust();
    act(() => {
      fireEvent.click(actionButton());
      expect(actionButton()).toHaveTextContent("Remove 3 units");
      fireEvent.click(actionButton());
    });

    await waitFor(() => expect(adjustCalls().length).toBeGreaterThanOrEqual(1));
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(adjustCalls()).toHaveLength(1);
  });

  // B3-1 FD4-1: the latch is released on a FAILED save too — otherwise one
  // 4xx/5xx would leave the dialog ignoring the action, Cancel, Escape and X.
  it("after a failed save the latch is released: the action sends again, Cancel closes (FD4-1)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    adjustAnswer = { status: 400, body: { error: "Insufficient stock. Available: 2, Requested: 3" } };
    await readyGuarded(user, onOpenChange);

    await user.click(actionButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Insufficient stock. Available: 2, Requested: 3"));
    expect(adjustCalls()).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await waitFor(() => expect(actionButton()).toBeEnabled());
    await user.click(actionButton());
    await waitFor(() => expect(adjustCalls()).toHaveLength(2));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(cancelButton()).toBeEnabled());
    await user.click(cancelButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });
});

// ===========================================================================
// MOUNTED PER OPEN — FR3's same-product keep (`:382` / `:396`) INVERTED, and
// FR2/FR3's product-swap pins re-expressed against the hosts' contract.
// ===========================================================================

describe("every open is a fresh draft", () => {
  async function cancelAndOpen(user: User, which: "Adjust A" | "Adjust B") {
    await user.click(cancelButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: which }));
    await stockReady();
  }

  it("A → pick → Cancel → A again: the pick is GONE (inverted)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);

    await cancelAndOpen(user, "Adjust A");
    expect(screen.queryByTestId("order-number-picked")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Order number" })).toBeNull();

    await user.type(quantityField(), "3");
    await intoOrder(user);
    expect(orderField()).toHaveValue("");
    const body = await submit(user);
    expect(body).toMatchObject({ productId: 42, delta: -3, intent: "order" });
    expect("selectedExternalOrderId" in body).toBe(false);
    expect("orderReference" in body).toBe(false);
  });

  it("A → type a number → Cancel → A again: the number is GONE (inverted)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "9999");

    await cancelAndOpen(user, "Adjust A");
    await user.type(quantityField(), "3");
    await intoOrder(user);
    expect(orderField()).toHaveValue("");
    const body = await submit(user);
    expect("orderReference" in body).toBe(false);
  });

  it.each([
    ["a pick", (user: User) => pickOrder(user)],
    ["a typed number", (user: User) => typeOrder(user, "9999")],
  ])("A → %s → Cancel → B: B's draft is empty and its body names no order", async (_label, enter) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await enter(user);

    await cancelAndOpen(user, "Adjust B");
    expect(screen.getByText("BPC 5mg")).toBeInTheDocument();
    expect(quantityField()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove" })).toHaveAttribute("aria-pressed", "true");
    for (const radio of chipGroup().getAllByRole("radio")) expect(radio).toHaveAttribute("aria-checked", "false");

    await user.type(quantityField(), "3");
    await intoOrder(user);
    expect(orderField()).toHaveValue("");
    const body = await submit(user);
    expect(body).toMatchObject({ productId: 43, delta: -3, intent: "order" });
    expect("selectedExternalOrderId" in body).toBe(false);
    expect("orderReference" in body).toBe(false);
  });

  // FD1-1's probe, against the hosts' contract: a layout effect reads the
  // screen after EVERY commit, before any passive effect. No commit ever shows
  // product B beside A's capture, because B's dialog is a new mount.
  it.each([
    ["a pick", (user: User) => pickOrder(user)],
    ["a typed number", (user: User) => typeOrder(user, "9999")],
  ])("no COMMITTED render ever shows product B with A's capture (%s)", async (_label, enter) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const mismatches: string[] = [];
    function CommitProbe() {
      React.useLayoutEffect(() => {
        const showsB = document.body.textContent?.includes(PRODUCT_B.name) ?? false;
        const picked = document.querySelector('[data-testid="order-number-picked"]');
        const field = document.querySelector<HTMLInputElement>('input[placeholder="e.g. 20105"]');
        if (showsB && (picked !== null || (field !== null && field.value !== ""))) {
          mismatches.push(`picked=${picked?.textContent ?? "-"}; text=${field?.value ?? "-"}`);
        }
      });
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PerOpenHost>
          <CommitProbe />
        </PerOpenHost>
      </QueryClientProvider>,
    );
    await stockReady();
    await user.type(quantityField(), "3");
    await intoOrder(user);
    await enter(user);

    await cancelAndOpen(user, "Adjust B");
    await intoOrder(user);
    expect(mismatches).toEqual([]);
    expect(orderField()).toHaveValue("");
  });

  // FR3's Q/A window, against the hosts' contract: A's save settles, the
  // success closes (and so unmounts) the dialog, and B opens on a new mount.
  // Nothing queued by A's dialog can land in B's.
  it("A's save settling never reaches B: B opens empty and its body names no order", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);

    const releaseA = holdNextAdjust();
    await user.click(actionButton());
    await waitFor(() => expect(adjustCalls()).toHaveLength(1));
    releaseA();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Adjust B" }));
    await stockReady();
    await user.type(quantityField(), "3");
    await intoOrder(user);
    expect(screen.queryByTestId("order-number-picked")).toBeNull();
    expect(orderField()).toHaveValue("");
    const body = await submit(user);
    expect(body).toMatchObject({ productId: 43, delta: -3 });
    expect("selectedExternalOrderId" in body).toBe(false);
    expect("orderReference" in body).toBe(false);
  });
});

// ===========================================================================
// THE REJECTED PICK (R-b.2)
// ===========================================================================

describe("the rejected pick", () => {
  const REJECTED = { status: 400, body: { error: SELECTED_ORDER_REJECTED_SENTENCE, code: "VALIDATION_ERROR" } };

  it("no toast; the pick becomes its number; a NON-blocking notice; the action stays enabled", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = jest.fn();
    adjustAnswer = REJECTED;
    await ready(user, { onOpenChange });
    await intoOrder(user);
    await pickOrder(user);

    await submit(user);
    await waitFor(() =>
      expect(message()).toBe(
        'That order can\'t be used anymore — tap "Remove 3 units" again to save the number without linking it.',
      ),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastPlain).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("order-number-picked")).toBeNull();
    expect(orderField()).toHaveValue("2044");
    expect(orderLine()).toBe("Order number to save: 2044");
    expect(screen.getByTestId("adjust-message")).toHaveClass("text-warning");
    expect(actionButton()).toBeEnabled();
  });

  it("a second tap sends the REFERENCE (no id)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer = REJECTED;
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);
    const first = await submit(user);
    expect(first.selectedExternalOrderId).toBe("ord-2");
    await waitFor(() => expect(message()).not.toBeNull());

    adjustAnswer = { status: 200, body: { success: true, log: { id: 1, orderRecordId: null }, batchId: "b-2" } };
    const second = await submit(user);
    expect(second.orderReference).toBe("2044");
    expect("selectedExternalOrderId" in second).toBe(false);
  });

  it("the notice is cleared by the next edit", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer = REJECTED;
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);
    await submit(user);
    await waitFor(() => expect(message()).not.toBeNull());

    await user.type(noteField(), "x");
    expect(message()).toBeNull();
  });

  it("an ill-shaped picked number becomes EMPTY text, and the notice says it saves without one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    searchOrders = [{ ...ORDER_2044, id: "ord-wc", orderNumber: "WC-2044" }];
    adjustAnswer = REJECTED;
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "2044");
    await user.click(screen.getByTestId("order-number-row-ord-wc"));

    await submit(user);
    await waitFor(() =>
      expect(message()).toBe(
        'That order can\'t be used anymore — tap "Remove 3 units" again to save without an order number.',
      ),
    );
    expect(orderField()).toHaveValue("");
    expect(actionButton()).toBeEnabled();

    adjustAnswer = { status: 200, body: { success: true, log: { id: 1, orderRecordId: null }, batchId: "b-2" } };
    const second = await submit(user);
    expect("orderReference" in second).toBe(false);
    expect("selectedExternalOrderId" in second).toBe(false);
  });

  it("any OTHER 400 is a failed save: the server's sentence, and the pick is kept", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer = { status: 400, body: { error: "something else entirely", code: "VALIDATION_ERROR" } };
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);
    await submit(user);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("something else entirely"));
    expect(screen.getByTestId("order-number-picked")).toBeInTheDocument();
    expect(message()).toBeNull();
  });
});

// ===========================================================================
// THE FOOTER
// ===========================================================================

describe("the footer", () => {
  it("the summary and the action label follow the direction and the count", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    expect(summary()).toBe("Remove units of AOD 2mg at Office");
    expect(actionButton()).toHaveTextContent(/^Remove units$/);

    await user.type(quantityField(), "1");
    expect(summary()).toBe("Remove 1 unit of AOD 2mg at Office");
    expect(actionButton()).toHaveTextContent(/^Remove 1 unit$/);

    await user.type(quantityField(), "2");
    expect(summary()).toBe("Remove 12 units of AOD 2mg at Office");
    expect(actionButton()).toHaveTextContent(/^Remove 12 units$/);

    await tapDirection(user, "Add");
    expect(summary()).toBe("Add 12 units of AOD 2mg at Office");
    expect(actionButton()).toHaveTextContent(/^Add 12 units$/);

    await user.clear(quantityField());
    expect(summary()).toBe("Add units of AOD 2mg at Office");
    expect(actionButton()).toHaveTextContent(/^Add units$/);
  });

  it("the order line, under Remove + Order only: the pick, the number to save, or none", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    expect(orderLine()).toBeNull();

    await intoOrder(user);
    expect(orderLine()).toBe("No order number — this removal won't be linked to an order.");

    await typeOrder(user, "9999");
    expect(orderLine()).toBe("Order number to save: 9999");

    await user.clear(orderField());
    await pickOrder(user);
    expect(orderLine()).toBe("Order 2044 · North Shop");

    await tapChip(user, "Other");
    expect(orderLine()).toBeNull();
    await tapChip(user, "Order");
    await tapDirection(user, "Add");
    expect(orderLine()).toBeNull();
  });

  it("the action and Cancel are 44 px", async () => {
    renderHost();
    expect(actionButton()).toHaveClass("min-h-[44px]");
    expect(cancelButton()).toHaveClass("min-h-[44px]");
  });
});

// ===========================================================================
// THE TOASTS (unit/units by count)
// ===========================================================================

describe("the toasts", () => {
  it("Add", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onSuccess = jest.fn();
    const onOpenChange = jest.fn();
    await ready(user, { onSuccess, onOpenChange });
    await tapDirection(user, "Add");
    await submit(user);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]).toEqual(["Added 3 units of AOD 2mg at Office."]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([["no chip", null], ["Other", "Other"], ["Damage / loss", "Damage / loss"]])(
    "Remove, chip %s",
    async (_label, chip) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await ready(user);
      if (chip) await tapChip(user, chip);
      await submit(user);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      expect(toastSuccess.mock.calls[0]).toEqual(["Removed 3 units of AOD 2mg at Office."]);
    },
  );

  it("one unit", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderHost();
    await stockReady();
    await user.type(quantityField(), "1");
    await submit(user);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]).toEqual(["Removed 1 unit of AOD 2mg at Office."]);
  });

  it("Remove under Order, nothing entered — even when the server stamped (an API-side stamp is not the operator's)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-9" }, batchId: "b-1" };
    await ready(user);
    await intoOrder(user);
    await submit(user);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]).toEqual([
      "Removed 3 units of AOD 2mg at Office — not linked to an order.",
    ]);
  });

  it("stamped from a TYPED number", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-9" }, batchId: "b-1" };
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "9999");
    await submit(user);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]).toEqual(["Removed 3 units of AOD 2mg — linked to order 9999."]);
    expect(toastPlain).not.toHaveBeenCalled();
  });

  it("stamped from a PICK", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer.body = { success: true, log: { id: 1, orderRecordId: "ord-2" }, batchId: "b-1" };
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);
    await submit(user);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]).toEqual(["Removed 3 units of AOD 2mg — linked to order 2044."]);
  });

  it("typed, NOT stamped: the plain toast, held for 10 s; the success toasts carry no options", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "9999");
    await submit(user);
    await waitFor(() => expect(toastPlain).toHaveBeenCalledTimes(1));
    expect(toastPlain.mock.calls[0]).toEqual([
      "Removed 3 units of AOD 2mg. Order 9999 wasn't linked — the number is saved so an admin can link it later.",
      { duration: 10000 },
    ]);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("a PICK the server did not stamp is never said as linked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer.body = { success: true };
    await ready(user);
    await intoOrder(user);
    await pickOrder(user);
    await submit(user);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]).toEqual([
      "Removed 3 units of AOD 2mg at Office — not linked to an order.",
    ]);
    expect(toastPlain).not.toHaveBeenCalled();
  });

  it("a server 400 still renders the server's own sentence, and the dialog stays", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    adjustAnswer = {
      status: 400,
      body: {
        error: "a reference attributes stock that left — put stock back with a correction",
        code: "VALIDATION_ERROR",
      },
    };
    await ready(user);
    await intoOrder(user);
    await typeOrder(user, "9999");
    await submit(user);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toBe(
      "a reference attributes stock that left — put stock back with a correction",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastPlain).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// ===========================================================================
// FOCUS: the order field takes it only right after the chip turns to Order
// ===========================================================================

describe("focus", () => {
  const original = Element.prototype.scrollIntoView;
  let scrollIntoView: jest.Mock;
  beforeEach(() => {
    scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("tapping Order focuses the order field and scrolls it to the centre", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    expect(orderField()).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("the field shown again by a direction change does NOT take focus", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await ready(user);
    await intoOrder(user);
    await tapDirection(user, "Add");
    await tapDirection(user, "Remove");
    expect(orderField()).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus();
  });
});
