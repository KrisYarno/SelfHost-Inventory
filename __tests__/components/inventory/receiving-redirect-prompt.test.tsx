/** @jest-environment jsdom */
/**
 * W1-4b — T5, the positive-delta receiving redirect.
 *
 * The lane's whole adoption problem is that adding stock through a quick adjust
 * or a stock-in leaves NO receipt: no expected-vs-counted, no discrepancy, no
 * `inboundShipmentId` on the ledger row. T5's answer is a nudge at exactly the
 * moment the operator reveals they are adding units — and it is a NUDGE, not a
 * gate:
 *
 *   - it appears only on a POSITIVE delta (never on a removal, never on 0);
 *   - it offers /receiving and nothing else;
 *   - DECLINING CHANGES NOTHING — the dialog underneath submits the identical
 *     request it would have submitted if the prompt had never rendered;
 *   - it is ONE TIME PER SESSION. A banner that reappears on every adjustment
 *     is a banner people learn to click through, and then it stops being
 *     information.
 *
 * The named surfaces are components/inventory/quick-adjust-dialog.tsx (ADD mode
 * only) and components/inventory/stock-in-dialog.tsx. The journal batch adjust
 * is deliberately EXCLUDED (registered plan decision).
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ selectedLocationId: 2, locations: [{ id: 2, name: "Office" }] }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

import {
  ReceivingRedirectPrompt,
  RECEIVING_PROMPT_SESSION_KEY,
} from "@/components/inventory/receiving-redirect-prompt";
import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";
import { StockInDialog } from "@/components/inventory/stock-in-dialog";

const PROMPT = /receiving a shipment\?/i;

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** Every request the dialogs make, so a decline can be proved inert. */
function mockFetch() {
  const fn = jest.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/inventory/product/")) {
      return { ok: true, json: async () => ({ currentQuantity: 7 }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ success: true }) } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const writeCalls = (fn: jest.Mock) =>
  fn.mock.calls.filter((c) => !String(c[0]).includes("/api/inventory/product/"));

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  mockFetch();
});

// ---------------------------------------------------------------------------
// The prompt itself
// ---------------------------------------------------------------------------

describe("ReceivingRedirectPrompt", () => {
  it("renders on a positive delta and points at /receiving", () => {
    render(<ReceivingRedirectPrompt active />);

    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /receiving/i })).toHaveAttribute(
      "href",
      "/receiving",
    );
  });

  it("renders NOTHING while the delta is not positive", () => {
    const { container } = render(<ReceivingRedirectPrompt active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("declining dismisses it (and nothing else happens)", async () => {
    const user = userEvent.setup();
    render(<ReceivingRedirectPrompt active />);

    await user.click(screen.getByRole("button", { name: /no|continue/i }));

    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
  });

  it("marks the session the first time it renders", async () => {
    render(<ReceivingRedirectPrompt active />);

    await waitFor(() =>
      expect(window.sessionStorage.getItem(RECEIVING_PROMPT_SESSION_KEY)).toBe("1"),
    );
  });

  it("never renders a second time in the same session", async () => {
    const first = render(<ReceivingRedirectPrompt active />);
    await waitFor(() =>
      expect(window.sessionStorage.getItem(RECEIVING_PROMPT_SESSION_KEY)).toBe("1"),
    );
    first.unmount();

    const { container } = render(<ReceivingRedirectPrompt active />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders when sessionStorage is unavailable (private mode)", () => {
    const getItem = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });

    expect(() => render(<ReceivingRedirectPrompt active />)).not.toThrow();
    expect(screen.getByText(PROMPT)).toBeInTheDocument();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Surface 1 — the quick adjust, ADD mode only
// ---------------------------------------------------------------------------

describe("QuickAdjustDialog (add mode)", () => {
  const product = { id: 42, name: "AOD 2mg" };

  it("prompts once a positive quantity is entered", async () => {
    const user = userEvent.setup();
    wrap(<QuickAdjustDialog open onOpenChange={() => {}} product={product} />);

    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Quantity"), "5");

    expect(screen.getByText(PROMPT)).toBeInTheDocument();
  });

  it("never prompts in REMOVE mode — that is not a receipt", async () => {
    const user = userEvent.setup();
    wrap(<QuickAdjustDialog open onOpenChange={() => {}} product={product} />);

    await user.click(screen.getByLabelText(/remove stock/i));
    await user.type(screen.getByLabelText("Quantity"), "5");

    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
  });

  it("DECLINE leaves the adjustment identical — same request, same body", async () => {
    const user = userEvent.setup();
    const fetchFn = global.fetch as jest.Mock;
    wrap(<QuickAdjustDialog open onOpenChange={() => {}} product={product} />);

    await user.type(screen.getByLabelText("Quantity"), "5");
    await user.click(screen.getByRole("button", { name: /no|continue/i }));
    await user.type(screen.getByLabelText("Reason (required)"), "restock");
    await user.click(screen.getByRole("button", { name: /confirm adjustment/i }));

    await waitFor(() => expect(writeCalls(fetchFn).length).toBe(1));
    const [, init] = writeCalls(fetchFn)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      productId: 42,
      locationId: 2,
      delta: 5,
      reason: "restock",
    });
  });
});

// ---------------------------------------------------------------------------
// Surface 2 — the stock-in dialog (every stock-in is a positive delta)
// ---------------------------------------------------------------------------

describe("StockInDialog", () => {
  const product = { id: 42, name: "AOD 2mg" };

  it("prompts once a positive quantity is entered", async () => {
    const user = userEvent.setup();
    wrap(<StockInDialog open onOpenChange={() => {}} product={product} />);

    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/quantity to add/i), "12");

    expect(screen.getByText(PROMPT)).toBeInTheDocument();
  });

  it("DECLINE leaves the stock-in identical — same request, same body", async () => {
    const user = userEvent.setup();
    const fetchFn = global.fetch as jest.Mock;
    wrap(<StockInDialog open onOpenChange={() => {}} product={product} />);

    await user.type(screen.getByLabelText(/quantity to add/i), "12");
    await user.click(screen.getByRole("button", { name: /no|continue/i }));
    await user.click(screen.getByRole("button", { name: /add 12 units/i }));

    await waitFor(() => expect(writeCalls(fetchFn).length).toBe(1));
    const [, init] = writeCalls(fetchFn)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      productId: 42,
      locationId: 2,
      quantity: 12,
    });
  });

  it("does not prompt a second time in the same session (the quick adjust used it)", async () => {
    const user = userEvent.setup();
    const first = wrap(
      <QuickAdjustDialog open onOpenChange={() => {}} product={product} />,
    );
    await user.type(screen.getByLabelText("Quantity"), "5");
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    first.unmount();

    wrap(<StockInDialog open onOpenChange={() => {}} product={product} />);
    await user.type(screen.getByLabelText(/quantity to add/i), "12");

    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
  });
});
