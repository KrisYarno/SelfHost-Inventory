/** @jest-environment jsdom */
//
// W2-1 (contract pack REV-11 T7) — the intent chip REPLACES quick-adjust's
// reason-code select.
//
// Two things are under contract here and they pull in opposite directions:
//   1. there must be NO double-entry path — the old coded-reason select is gone
//      from the surface entirely (the route refuses the vocabulary as well; see
//      __tests__/integration/api/w2-intent-chip.test.ts);
//   2. the chip must never become a gate — the design's friction ceiling is a
//      SKIPPABLE one-tap, so a submit with no chip interaction is legal and
//      lands as `other` (the request carries no intent at all).
import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), message: jest.fn() },
}));

import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/inventory/product/")) {
      return { ok: true, json: async () => ({ currentQuantity: 40 }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ success: true }) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <QuickAdjustDialog
        open
        onOpenChange={() => {}}
        product={{ id: 42, name: "AOD 2mg" }}
        onSuccess={() => {}}
      />
    </QueryClientProvider>
  );
}

/**
 * The chip's own radiogroup. The dialog has a SECOND one (Add / Remove stock),
 * so every chip assertion scopes to this group by its accessible name — an
 * unscoped getAllByRole("radio") would silently conflate the two.
 */
const chipGroup = () => within(screen.getByRole("radiogroup", { name: "What was this for?" }));

/** Fill the fields the dialog has always required, then submit. */
async function submitWith(user: ReturnType<typeof userEvent.setup>, chip?: string) {
  await user.type(screen.getByLabelText("Quantity"), "3");
  await user.type(screen.getByLabelText("Reason (required)"), "tested bad");
  if (chip) await user.click(chipGroup().getByRole("radio", { name: chip }));
  await user.click(screen.getByRole("button", { name: /confirm adjustment/i }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]) === "/api/inventory/adjust")
    ).toBe(true)
  );
  const call = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/inventory/adjust")!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe("quick-adjust — the chip replaced the reason-code select", () => {
  it("no longer renders the coded-reason select at all", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());

    expect(screen.queryByLabelText(/reason code/i)).toBeNull();
    expect(screen.queryByText("Count correction")).toBeNull();
    expect(screen.queryByText("Theft")).toBeNull();
    expect(screen.queryByText("Expiry")).toBeNull();
  });

  it("offers exactly the three chip values", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());

    expect(chipGroup().getAllByRole("radio")).toHaveLength(3);
    expect(chipGroup().getByRole("radio", { name: "Order" })).toBeInTheDocument();
    expect(chipGroup().getByRole("radio", { name: "Damage / loss" })).toBeInTheDocument();
    expect(chipGroup().getByRole("radio", { name: "Other" })).toBeInTheDocument();
    // Nothing is pre-selected: the untapped state has to be distinguishable
    // from a deliberate "Other".
    for (const radio of chipGroup().getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-checked", "false");
    }
  });
});

describe("quick-adjust — the chip never blocks", () => {
  it("submits with no chip interaction and sends NO intent (lands as other)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());

    const body = await submitWith(user);

    expect("intent" in body).toBe(false);
    // The old vocabulary is not smuggled along either.
    expect("reasonCode" in body).toBe(false);
  });

  it("sends the tapped value when the operator does tap", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/40 units/)).toBeInTheDocument());

    const body = await submitWith(user, "Damage / loss");

    expect(body.intent).toBe("damage-loss");
    expect("reasonCode" in body).toBe(false);
  });
});
