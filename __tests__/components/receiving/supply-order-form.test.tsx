/** @jest-environment jsdom */
/**
 * The supply-order entry form (contract pack C4a.3, spec §4.1).
 *
 * The order is entered WHEN IT IS PLACED, so this form is the moment the ledger
 * learns what was bought. Five things it must never get wrong:
 *
 *   1. THE ORDERED DATE IS A CALENDAR DAY. It is built from LOCAL getters and
 *      submitted as the lexical `YYYY-MM-DD` string the operator sees — the
 *      client never constructs a Date from it, because `toISOString()` on a
 *      local midnight is yesterday for half the planet.
 *   2. FEES DEFAULT TO 0, not to NULL. A form submitted without fees genuinely
 *      had none; NULL is "not recorded", which only a later PATCH can say.
 *   3. COST NEVER TRAVELS FROM A LINE. A product created here carries no
 *      `costPrice` at all — the receipt's own unit cost prices it later (D10).
 *   4. THE UNIT COST IS DERIVED AND SHOWN WITH ITS DERIVATION. One function
 *      (`lineMoney`) owns the arithmetic; the form only renders what it says,
 *      including "no unit cost" for a free line.
 *   5. THE PICKER IS UX, NOT AUTHORITY. It offers approved products and the
 *      operator's OWN pending ones; the server is what actually decides.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: jest.fn() }),
}));

const mockSession: { data: { user: Record<string, unknown> } | null } = {
  data: { user: { id: 7, isAdmin: false, defaultLocationId: 1 } },
};
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({
    token: "csrf-token",
    isLoading: false,
    error: null,
    refreshToken: jest.fn(),
  }),
  withCSRFHeaders: (headers: Record<string, string>) => ({
    ...headers,
    "x-csrf-token": "csrf-token",
  }),
}));

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

jest.mock("@/hooks/use-locations", () => ({
  useLocations: () => ({ data: [{ id: 1, name: "Main" }], isFetching: false }),
  locationKeys: { all: ["locations"] },
}));

const mockProducts = jest.fn();
jest.mock("@/hooks/use-products", () => ({
  useProducts: (filters: unknown) => mockProducts(filters),
}));

import { SupplyOrderForm } from "@/components/receiving/supply-order-form";

const APPROVED = {
  id: 11,
  name: "BPC-157 5mg",
  approvalStatus: "APPROVED",
  createdBy: 99,
};
const OWN_PENDING = {
  id: 12,
  name: "TB-500 10mg",
  approvalStatus: "PENDING_REVIEW",
  createdBy: 7,
};
const SOMEONE_ELSES_PENDING = {
  id: 13,
  name: "Ipamorelin 2mg",
  approvalStatus: "PENDING_REVIEW",
  createdBy: 42,
};

const mockFetch = jest.fn();

function renderForm(handlers: { onCreated?: jest.Mock; onCancel?: jest.Mock } = {}) {
  const onCreated = handlers.onCreated ?? jest.fn();
  const onCancel = handlers.onCancel ?? jest.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SupplyOrderForm onCreated={onCreated} onCancel={onCancel} />
    </QueryClientProvider>,
  );
  return { onCreated, onCancel };
}

/** The body of the single POST the form made. */
function submittedBody() {
  const call = mockFetch.mock.calls.find(
    ([url, init]) => String(url) === "/api/inbound-shipments" && init?.method === "POST",
  );
  return call ? JSON.parse(call[1].body) : null;
}

async function pickProduct(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByTestId("product-search-0"));
  await user.type(screen.getByTestId("product-search-0"), name.slice(0, 3));
  await user.click(await screen.findByRole("button", { name: new RegExp(name, "i") }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.data = { user: { id: 7, isAdmin: false, defaultLocationId: 1 } };
  mockProducts.mockReturnValue({
    data: { products: [APPROVED, OWN_PENDING, SOMEONE_ELSES_PENDING], total: 3 },
    isFetching: false,
  });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ model: "supply-order", id: "cksupply1", lines: [] }),
  });
  global.fetch = mockFetch as unknown as typeof fetch;
});

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

describe("the order header", () => {
  it("defaults the ordered date from LOCAL getters and submits the string VERBATIM", async () => {
    const user = userEvent.setup();
    renderForm();

    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    const date = screen.getByLabelText(/ordered date/i) as HTMLInputElement;
    expect(date.value).toBe(expected);

    fireEvent.change(date, { target: { value: "2026-01-01" } });
    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "10");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "100.01");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    await waitFor(() => expect(submittedBody()).not.toBeNull());
    // The lexical day, untouched — no Date round-trip anywhere on the client.
    expect(submittedBody().orderedAt).toBe("2026-01-01");
  });

  it("fees DEFAULT to 0 cents — an order with no fee had none", async () => {
    const user = userEvent.setup();
    renderForm();

    expect((screen.getByLabelText(/^fees/i) as HTMLInputElement).value).toBe("0.00");

    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "2");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "0.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    await waitFor(() => expect(submittedBody()).not.toBeNull());
    expect(submittedBody().feesCents).toBe(0);
    // A line total of 0 is a FACT (free), and it travels as 0, not as null.
    expect(submittedBody().lines[0].lineTotalCents).toBe(0);
  });

  it("fees typed in dollars arrive as whole cents", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText(/^fees/i));
    await user.type(screen.getByLabelText(/^fees/i), "42.35");
    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "1");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "1.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    await waitFor(() => expect(submittedBody()).not.toBeNull());
    expect(submittedBody().feesCents).toBe(4235);
  });
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

describe("lines", () => {
  it("starts with ONE line and refuses to leave the order with none", async () => {
    renderForm();
    expect(screen.getAllByTestId(/^order-line-/)).toHaveLength(1);
    expect(screen.getByTestId("remove-line-0")).toBeDisabled();
  });

  it("shows the derived unit cost WITH its derivation as the numbers are typed", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "100");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "1250.00");

    expect(await screen.findByTestId("line-derivation-0")).toHaveTextContent(
      "$1,250.00 / 100 ordered = $12.50/unit",
    );
  });

  it("a FREE line has no unit cost — and says so instead of showing $0.00", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "5");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "0.00");

    const derivation = await screen.findByTestId("line-derivation-0");
    expect(derivation).not.toHaveTextContent("$0.00/unit");
    expect(derivation).toHaveTextContent(/no unit cost/i);
  });

  it("the footer totals the LINES and says the fees are separate", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "2");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "25.50");

    expect(screen.getByTestId("order-total")).toHaveTextContent("$25.50");
    expect(screen.getByTestId("order-total")).toHaveTextContent(/fees separate/i);
  });

  it("mirrors the server bounds client-side and never posts a body it knows is invalid", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "0");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "10.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    expect(await screen.findByTestId("supply-order-form-error")).toHaveTextContent(
      /at least 1 unit/i,
    );
    expect(submittedBody()).toBeNull();
  });

  it("refuses to submit a line with no product chosen", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "3");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "10.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    expect(await screen.findByTestId("supply-order-form-error")).toHaveTextContent(
      /product/i,
    );
    expect(submittedBody()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The product picker + the create-new sub-form
// ---------------------------------------------------------------------------

describe("the product picker", () => {
  it("asks `useProducts` for one page of 25 and offers APPROVED plus the operator's OWN pending", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByTestId("product-search-0"), "e");

    expect(mockProducts).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 25 }),
    );
    const options = screen.getByTestId("product-options-0");
    expect(within(options).getByRole("button", { name: /BPC-157/ })).toBeInTheDocument();
    expect(within(options).getByRole("button", { name: /TB-500/ })).toBeInTheDocument();
    // Somebody else's unapproved product is not the operator's to order against.
    expect(within(options).queryByRole("button", { name: /Ipamorelin/ })).toBeNull();
  });

  it("the create-new branch sends the product FIELDS and NEVER a costPrice", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByTestId("create-new-product-0"));
    await user.type(screen.getByTestId("new-product-base-name-0"), "Semax");
    await user.type(screen.getByTestId("new-product-variant-0"), "vial");
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "4");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "80.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    await waitFor(() => expect(submittedBody()).not.toBeNull());
    const line = submittedBody().lines[0];
    expect(line.product.mode).toBe("new");
    expect(line.product.productFields.baseName).toBe("Semax");
    expect(line.product.productFields.variant).toBe("vial");
    expect(Object.prototype.hasOwnProperty.call(line.product.productFields, "costPrice")).toBe(
      false,
    );
    expect(mockFetch.mock.calls[0][1].body).not.toContain("costPrice");
  });

  it("tells a non-admin their new product arrives PENDING REVIEW", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByTestId("create-new-product-0"));
    expect(screen.getByTestId("new-product-approval-note-0")).toHaveTextContent(
      /pending review/i,
    );
  });

  it("says nothing about pending review to an admin", async () => {
    mockSession.data = { user: { id: 7, isAdmin: true, defaultLocationId: 1 } };
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByTestId("create-new-product-0"));
    expect(screen.queryByTestId("new-product-approval-note-0")).toBeNull();
  });

  it("refuses a half-filled size — a unit with no value is a hole", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByTestId("create-new-product-0"));
    await user.type(screen.getByTestId("new-product-base-name-0"), "Semax");
    await user.type(screen.getByTestId("new-product-variant-0"), "vial");
    await user.type(screen.getByTestId("new-product-numeric-0"), "10");
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "4");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "80.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    expect(await screen.findByTestId("supply-order-form-error")).toHaveTextContent(/unit/i);
    expect(submittedBody()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

describe("submission", () => {
  it("hands the created order back and navigates to its detail", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderForm();

    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "3");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "30.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/receiving/cksupply1"));
    expect(onCreated).toHaveBeenCalled();
  });

  it("renders the server's 400 inline rather than swallowing it", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: "orderedAt is not a real calendar day",
        code: "VALIDATION_ERROR",
      }),
    });
    const user = userEvent.setup();
    renderForm();

    await pickProduct(user, APPROVED.name);
    await user.clear(screen.getByTestId("ordered-units-0"));
    await user.type(screen.getByTestId("ordered-units-0"), "3");
    await user.clear(screen.getByTestId("total-paid-0"));
    await user.type(screen.getByTestId("total-paid-0"), "30.00");
    await user.click(screen.getByRole("button", { name: /save supply order/i }));

    expect(await screen.findByTestId("supply-order-form-error")).toHaveTextContent(
      "orderedAt is not a real calendar day",
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("uses bg-surface, never the unregistered bg-card", () => {
    const client = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <SupplyOrderForm onCreated={jest.fn()} onCancel={jest.fn()} />
      </QueryClientProvider>,
    );
    expect(container.querySelectorAll(".bg-card")).toHaveLength(0);
  });
});
