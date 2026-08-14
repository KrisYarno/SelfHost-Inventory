/** @jest-environment jsdom */
/**
 * W1-3a — GraduateDialog (contract pack REV-3 T2).
 *
 * The dialog is where the count-46-book-50 defect was AUTHORED: it pre-filled a
 * typed "Counted Quantity" field from the row's EXPECTED quantity, and the
 * server booked whatever that field said. The fix is structural, not cosmetic:
 *
 *   - counted is READ-ONLY and comes from the row (or from the count endpoint's
 *     own response — never from a field the operator can type into and confirm);
 *   - Confirm is disabled while the row is uncounted, with copy that says so;
 *   - counting is a SEPARATE, visibly separate act that POSTs to the count
 *     endpoint — the dialog never writes a count through graduation;
 *   - booking a different number is possible but must be named and explained
 *     (the override pair).
 */
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// CSRF token present so the dialog's csrf gate passes.
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({
    ...h,
    "x-csrf-token": "test-csrf",
  }),
}));
const toastSuccess = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: jest.fn(),
    warning: jest.fn(),
  },
}));

import { GraduateDialog } from "@/components/staging/graduate-dialog";

const ITEM = {
  id: 42,
  description: "Unlabeled box of vials",
  expectedQuantity: null as number | null,
  countedQuantity: null as number | null,
  locationId: 1,
};

const LOCATIONS = [
  { id: 1, name: "Main Warehouse" },
  { id: 2, name: "Back Room" },
];

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

/**
 * Product search + duplicate-name checks resolve to an empty list; the count
 * endpoint echoes back what it was sent (the real W1-2b response shape).
 */
function mockFetch(products: unknown[] = []) {
  const fn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/count")) {
      const sent = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        json: async () => ({
          id: 42,
          status: "RECEIVED",
          countedQuantity: sent.countedQuantity,
          previousCountedQuantity: null,
          recount: false,
          countedBy: 7,
          countedAt: new Date().toISOString(),
          expectedQuantity: null,
          shipmentId: null,
          discrepancy: { counted: true, expectedMissing: true, delta: sent.countedQuantity, direction: "OVER" },
        }),
      } as unknown as Response;
    }
    if (u.includes("/graduate")) {
      return {
        ok: true,
        json: async () => ({
          productId: 7,
          approvalStatus: "APPROVED",
          locationId: 1,
          countedQuantity: 46,
          bookedQuantity: 46,
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ products: u.includes("search=") ? products : [] }),
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const calls = (): FetchCall[] => (global.fetch as jest.Mock).mock.calls as FetchCall[];
const urls = () => calls().map((c) => String(c[0]));
const bodyOf = (fragment: string) => {
  const call = calls().find((c) => String(c[0]).includes(fragment));
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
};

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof GraduateDialog>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <GraduateDialog
        open
        onOpenChange={jest.fn()}
        item={ITEM}
        locations={LOCATIONS}
        onSuccess={jest.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const PRODUCT = { id: 7, name: "BPC-157 5mg", approvalStatus: "APPROVED" };

async function selectProduct(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/search products/i), "bpc");
  await user.click(await screen.findByRole("button", { name: /BPC-157 5mg/i }));
}

describe("GraduateDialog — counted is read-only and comes from the row", () => {
  beforeEach(() => mockFetch());
  afterEach(() => jest.clearAllMocks());

  it("renders the row's count READ-ONLY (no typing into what gets booked)", () => {
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    const counted = screen.getByLabelText(/counted/i);
    expect(counted).toHaveValue("46");
    expect(counted).toHaveAttribute("readonly");
  });

  it("does NOT pre-fill counted from expectedQuantity (the authored defect)", () => {
    renderDialog({ item: { ...ITEM, expectedQuantity: 50, countedQuantity: null } });

    // The old dialog put 50 here and let Confirm book it.
    expect(screen.getByLabelText(/counted/i)).toHaveValue("");
  });

  it("an uncounted row disables Confirm and says why, even with a product chosen", async () => {
    const user = userEvent.setup();
    mockFetch([PRODUCT]);
    renderDialog({ item: { ...ITEM, expectedQuantity: 50, countedQuantity: null } });

    await selectProduct(user);

    expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();
    expect(screen.getByText(/count this item first/i)).toBeInTheDocument();
  });

  it("a counted row with a product chosen enables Confirm", async () => {
    const user = userEvent.setup();
    mockFetch([PRODUCT]);
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /confirm/i })).not.toBeDisabled(),
    );
  });

  it("a counted row of 0 keeps Confirm disabled — a zero count is a Discard", async () => {
    const user = userEvent.setup();
    mockFetch([PRODUCT]);
    renderDialog({ item: { ...ITEM, countedQuantity: 0 } });

    await selectProduct(user);

    expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();
    expect(screen.getByText(/zero count is a discard/i)).toBeInTheDocument();
  });

  it("Confirm sends NO quantity — the row is the only source of what is booked", async () => {
    const user = userEvent.setup();
    mockFetch([PRODUCT]);
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() =>
      expect(urls().some((u) => u.includes("/api/staging-items/42/graduate"))).toBe(true),
    );
    const body = bodyOf("/graduate");
    expect(body).toEqual({ mode: "existing", productId: 7, locationId: 1 });
    expect(body).not.toHaveProperty("countedQuantity");
  });
});

describe("GraduateDialog — the inline count control", () => {
  beforeEach(() => mockFetch([PRODUCT]));
  afterEach(() => jest.clearAllMocks());

  it("posts to the COUNT endpoint (not graduate) and adopts the response's number", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: null } });

    const panel = screen.getByTestId("graduate-count-control");
    await user.type(within(panel).getByRole("spinbutton"), "46");
    await user.click(within(panel).getByRole("button", { name: /save count/i }));

    await waitFor(() =>
      expect(urls().some((u) => u.includes("/api/staging-items/42/count"))).toBe(true),
    );
    expect(bodyOf("/count")).toEqual({ countedQuantity: 46 });
    // Nothing was graduated by counting — the two-step stays forbidden.
    expect(urls().some((u) => u.includes("/graduate"))).toBe(false);

    // The read-only display now shows the SERVER's number.
    await waitFor(() => expect(screen.getByLabelText(/counted/i)).toHaveValue("46"));
  });

  it("counting releases Confirm without a reload", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: null } });

    await selectProduct(user);
    expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();

    const panel = screen.getByTestId("graduate-count-control");
    await user.type(within(panel).getByRole("spinbutton"), "46");
    await user.click(within(panel).getByRole("button", { name: /save count/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /confirm/i })).not.toBeDisabled(),
    );
  });

  it("a count of 0 is accepted by the control (the box was empty is a fact)", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: null } });

    const panel = screen.getByTestId("graduate-count-control");
    await user.type(within(panel).getByRole("spinbutton"), "0");
    await user.click(within(panel).getByRole("button", { name: /save count/i }));

    await waitFor(() => expect(bodyOf("/count")).toEqual({ countedQuantity: 0 }));
  });

  it("the Save-count button is separate from Confirm (two buttons, two acts)", async () => {
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    const panel = screen.getByTestId("graduate-count-control");
    const save = within(panel).getByRole("button", { name: /save count/i });
    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect(save).not.toBe(confirm);
    expect(panel).not.toContainElement(confirm);
  });
});

describe("GraduateDialog — the override affordance", () => {
  beforeEach(() => mockFetch([PRODUCT]));
  afterEach(() => jest.clearAllMocks());

  it("starts COLLAPSED (the default path books the count)", () => {
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    expect(
      screen.getByRole("button", { name: /book a different quantity/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/quantity to book/i)).not.toBeInTheDocument();
  });

  it("expands to the PAIR — quantity and reason", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await user.click(screen.getByRole("button", { name: /book a different quantity/i }));

    expect(screen.getByLabelText(/quantity to book/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reason/i)).toBeInTheDocument();
  });

  it("a half-filled pair disables Confirm (both-or-neither, mirrored client-side)", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);
    await user.click(screen.getByRole("button", { name: /book a different quantity/i }));
    await user.type(screen.getByLabelText(/quantity to book/i), "40");

    expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();
  });

  it("a complete pair rides the graduate body", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);
    await user.click(screen.getByRole("button", { name: /book a different quantity/i }));
    await user.type(screen.getByLabelText(/quantity to book/i), "40");
    await user.type(screen.getByLabelText(/reason/i), "six vials broken in transit");
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(bodyOf("/graduate")).not.toBeNull());
    expect(bodyOf("/graduate")).toEqual({
      mode: "existing",
      productId: 7,
      locationId: 1,
      overrideQuantity: 40,
      overrideReason: "six vials broken in transit",
    });
  });

  it("collapsing the affordance drops the pair from the body", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);
    const toggle = screen.getByRole("button", { name: /book a different quantity/i });
    await user.click(toggle);
    await user.type(screen.getByLabelText(/quantity to book/i), "40");
    await user.type(screen.getByLabelText(/reason/i), "six vials broken in transit");
    await user.click(toggle); // collapse again
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(bodyOf("/graduate")).not.toBeNull());
    expect(bodyOf("/graduate")).toEqual({ mode: "existing", productId: 7, locationId: 1 });
  });
});

describe("GraduateDialog — unchanged behaviour", () => {
  beforeEach(() => mockFetch());
  afterEach(() => jest.clearAllMocks());

  it("toggling Existing/New swaps the body", async () => {
    const user = userEvent.setup();
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    expect(screen.getByPlaceholderText(/search products/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/product name/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /new product/i }));
    expect(screen.getByLabelText(/product name/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search products/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /existing product/i }));
    expect(screen.getByPlaceholderText(/search products/i)).toBeInTheDocument();
  });

  it("New: the create button is gated on the COUNT, then graduates without a quantity", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog({ item: { ...ITEM, countedQuantity: null } });

    await user.click(screen.getByRole("button", { name: /new product/i }));
    const createBtn = screen.getByRole("button", { name: /create product/i });
    expect(createBtn).toBeDisabled();

    // Counting through the control releases it (same gate as Confirm).
    const panel = screen.getByTestId("graduate-count-control");
    await user.type(within(panel).getByRole("spinbutton"), "3");
    await user.click(within(panel).getByRole("button", { name: /save count/i }));
    await waitFor(() => expect(createBtn).not.toBeDisabled());

    await user.type(screen.getByLabelText(/product name/i), "Test Peptide");
    await user.type(screen.getByLabelText(/variant label/i), "Vial");
    await user.click(createBtn);

    await waitFor(() => expect(bodyOf("/graduate")).not.toBeNull());
    expect(bodyOf("/graduate")).not.toHaveProperty("countedQuantity");
    expect(bodyOf("/graduate").mode).toBe("new");
    void rerender;
  });
});

// ---------------------------------------------------------------------------
// W1-3b — D-COST in the dialog (contract pack REV-3 T3, seam S11).
// ---------------------------------------------------------------------------

/**
 * The server never overwrites a cost that already exists — it reports the
 * disagreement and lets a human settle it. For an ADMIN that report arrives as
 * `costPrompt` on the graduate response, and the settlement goes through the
 * REAL product PUT (same authorization, same audit line as any price edit).
 * A non-admin never sees this: their response carries `costPrompt: null` and the
 * server has already written a cost-differs register row instead.
 */
function mockFetchWithPrompt(costPrompt: unknown) {
  const fn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/graduate")) {
      return {
        ok: true,
        json: async () => ({
          productId: 7,
          approvalStatus: "APPROVED",
          locationId: 1,
          countedQuantity: 46,
          bookedQuantity: 46,
          receiptCost: { unitCostCents: 1234, source: "line" },
          costPrompt,
        }),
      } as unknown as Response;
    }
    if (u.includes("/api/products/7") && init?.method === "PUT") {
      return { ok: true, json: async () => ({ id: 7 }) } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ products: u.includes("search=") ? [PRODUCT] : [] }),
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const PROMPT = { productId: 7, currentCents: 100, receiptCents: 1234 };

async function graduateWithPrompt(costPrompt: unknown) {
  const user = userEvent.setup();
  mockFetchWithPrompt(costPrompt);
  renderDialog({ item: { ...ITEM, countedQuantity: 46 } });
  await selectProduct(user);
  await user.click(screen.getByRole("button", { name: /confirm/i }));
  return user;
}

// ---------------------------------------------------------------------------
// QA-3 — the success toast renders the SERVER's numbers
// ---------------------------------------------------------------------------
//
// The dialog used to announce its OWN `bookedQuantity` (the row's count, or the
// override it just typed). That is a PREDICTION of what the server would do,
// and the one screen an operator reads after pressing Confirm has no business
// guessing: the server answers with both numbers, and an override is exactly
// the case where they differ.

/** A /graduate response with quantities of the caller's choosing. */
function mockFetchGraduateResult(result: Record<string, unknown>) {
  const fn = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/graduate")) {
      return {
        ok: true,
        json: async () => ({
          productId: 7,
          approvalStatus: "APPROVED",
          locationId: 1,
          receiptCost: { unitCostCents: null, source: "product" },
          costPrompt: null,
          ...result,
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ products: u.includes("search=") ? [PRODUCT] : [] }),
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("GraduateDialog — the success toast is the SERVER's answer (QA-3)", () => {
  afterEach(() => jest.clearAllMocks());

  it("announces the quantity the LEDGER booked, not the one the dialog predicted", async () => {
    const user = userEvent.setup();
    // The row says 46; the server booked 50. Only one of those is true.
    mockFetchGraduateResult({ countedQuantity: 46, bookedQuantity: 50 });
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls[0][0])).toContain("50");
  });

  it("says BOTH numbers when the booked quantity differs from the count (override)", async () => {
    const user = userEvent.setup();
    mockFetchGraduateResult({ countedQuantity: 46, bookedQuantity: 40 });
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);
    await user.click(screen.getByRole("button", { name: /book a different quantity/i }));
    await user.type(screen.getByLabelText(/quantity to book/i), "40");
    await user.type(screen.getByLabelText(/reason/i), "six vials broken in transit");
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const message = String(toastSuccess.mock.calls[0][0]);
    expect(message).toContain("40");
    // The count survives on the record and in the message — an override that
    // only ever says "40" hides the fact that the dock reported 46.
    expect(message).toMatch(/counted 46/i);
  });

  it("says ONE number when the ledger booked exactly what was counted", async () => {
    const user = userEvent.setup();
    mockFetchGraduateResult({ countedQuantity: 46, bookedQuantity: 46 });
    renderDialog({ item: { ...ITEM, countedQuantity: 46 } });

    await selectProduct(user);
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const message = String(toastSuccess.mock.calls[0][0]);
    expect(message).toContain("46");
    expect(message).not.toMatch(/counted 46/i);
  });
});

// ---------------------------------------------------------------------------
// QA-9 — counting from inside the dialog refreshes the RECEIVING view too
// ---------------------------------------------------------------------------

describe("GraduateDialog — counting invalidates both key families (QA-9)", () => {
  beforeEach(() => mockFetch());
  afterEach(() => jest.clearAllMocks());

  it("invalidates the shipment caches as well as the staging queue", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderDialog({ item: { ...ITEM, countedQuantity: null } });
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");

    await user.type(screen.getByLabelText(/record the count/i), "46");
    await user.click(screen.getByRole("button", { name: /save count/i }));

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["staging-items"]));
    // The receiving detail renders this count, and the freight calculator's
    // quantity basis rests on it — leaving it stale is how a bill gets split
    // across numbers nobody can see anymore.
    expect(keys).toContain(JSON.stringify(["inbound-shipments"]));
  });
});

describe("GraduateDialog — the cost prompt", () => {
  afterEach(() => jest.clearAllMocks());

  it("shows both numbers when the receipt disagrees with the product's cost", async () => {
    await graduateWithPrompt(PROMPT);

    const dialog = await screen.findByTestId("cost-prompt");
    // $1.00 on the product, $12.34 on this receipt — stated, never guessed.
    expect(within(dialog).getByText(/\$1\.00/)).toBeInTheDocument();
    expect(within(dialog).getByText(/\$12\.34/)).toBeInTheDocument();
  });

  it("Update sends the receipt cost through the REAL product PUT", async () => {
    const user = await graduateWithPrompt(PROMPT);

    const dialog = await screen.findByTestId("cost-prompt");
    await user.click(within(dialog).getByRole("button", { name: /update/i }));

    await waitFor(() =>
      expect(urls().some((u) => u.includes("/api/products/7"))).toBe(true),
    );
    const put = calls().find(
      (c) => String(c[0]).includes("/api/products/7") && (c[1] as RequestInit)?.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ costPrice: 12.34 });
  });

  it("Keep writes nothing at all", async () => {
    const user = await graduateWithPrompt(PROMPT);

    const dialog = await screen.findByTestId("cost-prompt");
    await user.click(within(dialog).getByRole("button", { name: /keep/i }));

    await waitFor(() => expect(screen.queryByTestId("cost-prompt")).not.toBeInTheDocument());
    expect(urls().some((u) => u.includes("/api/products/7"))).toBe(false);
  });

  it("no prompt when the server sent none (agreement, or a non-admin actor)", async () => {
    await graduateWithPrompt(null);

    await waitFor(() =>
      expect(urls().some((u) => u.includes("/graduate"))).toBe(true),
    );
    expect(screen.queryByTestId("cost-prompt")).not.toBeInTheDocument();
  });

  it("a product with NO standing cost is described as unknown, not as $0.00", async () => {
    await graduateWithPrompt({ productId: 7, currentCents: null, receiptCents: 1234 });

    const dialog = await screen.findByTestId("cost-prompt");
    expect(within(dialog).getByText(/not set|unknown/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });
});

describe("GraduateDialog — mode:new pre-fills the cost from the receipt line", () => {
  afterEach(() => jest.clearAllMocks());

  it("the typed line cost lands in the ProductForm cost field (one value, no conflict)", async () => {
    const user = userEvent.setup();
    mockFetch([PRODUCT]);
    renderDialog({ item: { ...ITEM, countedQuantity: 46, unitCostCents: 1234 } });

    await user.click(screen.getByRole("button", { name: /new product/i }));

    expect(screen.getByLabelText(/cost price/i)).toHaveValue(12.34);
  });

  it("a line with no cost leaves the field blank (unknown stays unknown)", async () => {
    const user = userEvent.setup();
    mockFetch([PRODUCT]);
    renderDialog({ item: { ...ITEM, countedQuantity: 46, unitCostCents: null } });

    await user.click(screen.getByRole("button", { name: /new product/i }));

    expect(screen.getByLabelText(/cost price/i)).toHaveValue(null);
  });
});
