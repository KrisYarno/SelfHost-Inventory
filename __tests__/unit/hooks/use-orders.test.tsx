/** @jest-environment jsdom */
//
// THE ORDERS HOOKS' ERROR READER (reconciliation Part 2, pack REV-22 F7).
//
// `useFulfillOrder` and `useFulfillmentValidation` both read `data.error.message`
// — the NESTED body shape. The fulfil route answers through `apiHandler`, which
// emits the FLAT one (`{ error: "...", code: "..." }`), so the reader saw
// `undefined` and every refusal reached the fulfil dialog as the same
// "Failed to fulfill order", with the code dropped.
//
// The dialog toasts `error.message`, so the message these hooks build IS the
// operator-facing copy.

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-token", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit, token: string | null) => ({
    ...(h as Record<string, string>),
    "x-csrf-token": token ?? "",
  }),
}));

import { useFulfillOrder, useFulfillmentValidation } from "@/hooks/use-orders";
import type { ApiMutationError } from "@/hooks/use-inventory-mutations";

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

function answerWith(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const FULFIL_INPUT = {
  orderId: "ord-1",
  locationId: 1,
  items: [{ itemId: "fi-1", quantity: 2 }],
};

describe("useFulfillOrder — the refusal it hands the dialog", () => {
  it("says the ORDER_GONE copy and keeps the code, off a FLAT body", async () => {
    answerWith(409, { error: "order ord-1 no longer exists", code: "ORDER_GONE" });
    const { result } = renderHook(() => useFulfillOrder(), { wrapper });

    const err = await result.current.mutateAsync(FULFIL_INPUT).catch((e) => e as ApiMutationError);

    expect(err.message).toBe("this order no longer exists — refresh and re-check");
    expect(err.code).toBe("ORDER_GONE");
  });

  it("passes an INSUFFICIENT_STOCK sentence through verbatim", async () => {
    answerWith(400, {
      error: "Product 501: Insufficient inventory: current 0, trying to remove 2",
      code: "INSUFFICIENT_STOCK",
    });
    const { result } = renderHook(() => useFulfillOrder(), { wrapper });

    const err = await result.current.mutateAsync(FULFIL_INPUT).catch((e) => e as ApiMutationError);

    expect(err.message).toBe(
      "Product 501: Insufficient inventory: current 0, trying to remove 2"
    );
    expect(err.code).toBe("INSUFFICIENT_STOCK");
  });

  it("still reads the legacy NESTED shape, context and all", async () => {
    answerWith(400, {
      error: {
        message: "Insufficient stock",
        code: "INVENTORY_INSUFFICIENT_STOCK",
        context: { productName: "Widget A" },
      },
    });
    const { result } = renderHook(() => useFulfillOrder(), { wrapper });

    const err = await result.current.mutateAsync(FULFIL_INPUT).catch((e) => e as ApiMutationError);

    expect(err.message).toBe("Insufficient stock");
    expect(err.code).toBe("INVENTORY_INSUFFICIENT_STOCK");
    expect(err.data).toEqual({ productName: "Widget A" });
  });

  it("falls back to its own sentence when the body says nothing", async () => {
    answerWith(500, {});
    const { result } = renderHook(() => useFulfillOrder(), { wrapper });

    const err = await result.current.mutateAsync(FULFIL_INPUT).catch((e) => e as ApiMutationError);

    expect(err.message).toBe("Failed to fulfill order");
    expect(err.code).toBeUndefined();
  });
});

describe("useFulfillmentValidation — the refusal it surfaces", () => {
  it("shows the validate route's own FLAT sentence", async () => {
    answerWith(400, { error: "locationId is required", code: "VALIDATION_ERROR" });
    const { result } = renderHook(() => useFulfillmentValidation("ord-1", 1), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("locationId is required");
  });
});
