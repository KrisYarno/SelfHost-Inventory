/**
 * THE SHARED CLIENT-SIDE API-ERROR READER (reconciliation Part 2, pack REV-22 F7).
 *
 * Two body shapes reach the client, and until this reader existed every call
 * site knew about exactly one of them:
 *
 *   FLAT   — what `apiHandler` actually emits: `{ error: "...", code: "..." }`
 *   NESTED — the legacy shape the dialogs were written against:
 *            `{ error: { message, code, context } }`
 *
 * A reader that knows only the nested shape drops the CODE of every AppError the
 * server sends (`INSUFFICIENT_STOCK`, `TOO_MANY_KEYS`, `ORDER_GONE` — the codes
 * B1 added), and shows the operator a generic "Failed to ..." fallback instead of
 * the server's own sentence. These pins are that both-shapes contract.
 */

import { readApiError, apiErrorMessage } from "@/lib/api-error";

describe("readApiError — the flat shape apiHandler emits", () => {
  it("reads message + code off `{ error: string, code }`", () => {
    expect(
      readApiError({
        error: "Product 5: Insufficient inventory: current 0, trying to remove 3",
        code: "INSUFFICIENT_STOCK",
      })
    ).toEqual({
      message: "Product 5: Insufficient inventory: current 0, trying to remove 3",
      code: "INSUFFICIENT_STOCK",
      context: undefined,
    });
  });

  it("reads a flat body with no code at all", () => {
    expect(readApiError({ error: "Internal server error" })).toEqual({
      message: "Internal server error",
      code: null,
      context: undefined,
    });
  });

  it("reads the 409 the optimistic-lock branch sends (flat, extra fields ignored)", () => {
    const read = readApiError({
      error: "Inventory was modified by another user",
      code: "OPTIMISTIC_LOCK_ERROR",
      currentVersion: 4,
      expectedVersion: 3,
    });
    expect(read.message).toBe("Inventory was modified by another user");
    expect(read.code).toBe("OPTIMISTIC_LOCK_ERROR");
  });
});

describe("readApiError — the legacy nested shape", () => {
  it("reads message + code + context off `{ error: { message, code, context } }`", () => {
    expect(
      readApiError({
        error: {
          message: "Insufficient stock",
          code: "INVENTORY_INSUFFICIENT_STOCK",
          context: { productName: "Widget A" },
        },
      })
    ).toEqual({
      message: "Insufficient stock",
      code: "INVENTORY_INSUFFICIENT_STOCK",
      context: { productName: "Widget A" },
    });
  });

  it("keeps a nested body's context even when it carries no code", () => {
    const read = readApiError({
      error: { message: "Partial failure", context: { results: [] } },
    });
    expect(read.code).toBeNull();
    expect(read.context).toEqual({ results: [] });
  });
});

describe("readApiError — bodies that say nothing", () => {
  it.each([[null], [undefined], ["a string body"], [{}], [{ error: 42 }]])(
    "returns an empty message and a null code for %p",
    (body) => {
      expect(readApiError(body)).toEqual({ message: "", code: null, context: undefined });
    }
  );

  it("still reports a code carried without a sentence", () => {
    expect(readApiError({ code: "ORDER_GONE" })).toEqual({
      message: "",
      code: "ORDER_GONE",
      context: undefined,
    });
  });

  it("never reads a code off Object.prototype", () => {
    expect(readApiError({ error: "boom", code: "constructor" }).code).toBe("constructor");
    expect(apiErrorMessage({ error: "boom", code: "constructor" }, "fallback")).toBe("boom");
  });
});

describe("apiErrorMessage — honest copy for the codes B1 added", () => {
  it("replaces ORDER_GONE's server sentence with copy the operator can act on", () => {
    expect(
      apiErrorMessage({ error: "order ord-1 no longer exists", code: "ORDER_GONE" }, "fallback")
    ).toBe("this order no longer exists — refresh and re-check");
  });

  it("passes TOO_MANY_KEYS's split-it sentence through verbatim", () => {
    expect(
      apiErrorMessage(
        { error: "too many restorations in one request — split it", code: "TOO_MANY_KEYS" },
        "fallback"
      )
    ).toBe("too many restorations in one request — split it");
  });

  it("passes INSUFFICIENT_STOCK's sentence through verbatim", () => {
    expect(
      apiErrorMessage(
        {
          error: "Product 5: Insufficient inventory: current 0, trying to remove 3",
          code: "INSUFFICIENT_STOCK",
        },
        "fallback"
      )
    ).toBe("Product 5: Insufficient inventory: current 0, trying to remove 3");
  });

  it("falls back to the caller's own sentence only when the body says nothing", () => {
    expect(apiErrorMessage({}, "Failed to fulfill order")).toBe("Failed to fulfill order");
    expect(apiErrorMessage({ error: "Failed to validate" }, "Failed to fulfill order")).toBe(
      "Failed to validate"
    );
  });
});
