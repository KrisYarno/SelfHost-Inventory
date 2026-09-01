// @jest-environment node
//
// Reconciliation Part 2, pack CB1.5c — `primaryRefusal`, the ONE reader of a
// fulfil envelope's refusal, pinned as the pure function it is.
//
// WHY A PRIORITY AND NOT AN INDEX. From B1.5 `skipped[]` arrives in PASS order
// (pass-1 refusals first, stock refusals after) and that order is explicitly
// NOT contractual (pack I5 / FVc-2). Reading `skipped[0]` would therefore let a
// pass-1 "unmapped" — a line the operator already saw flagged in validation —
// shadow the short line that is the actual reason the order did not go out.
//
// The helper is a LEAF nothing mocks (DCc-3): both dialogs import it directly,
// so these pins are the whole behavioural contract of what they render.

import { primaryRefusal } from "@/lib/orders/refusal";

describe("primaryRefusal — the four priority tiers", () => {
  it("TIER 1: the first insufficient_stock skip's details beats everything else", () => {
    const refusal = primaryRefusal({
      skipped: [
        { reason: "unmapped", details: "Item is not mapped to an internal product" },
        {
          reason: "insufficient_stock",
          details: "Insufficient stock for Widget. Available: 1, Requested: 2",
        },
        {
          reason: "insufficient_stock",
          details: "Insufficient stock for Vial. Available: 0, Requested: 5",
        },
      ],
      failed: [{ error: "Item not found in order" }],
    });

    // The FIRST short line, quoting the exact locked quantity (QB-9) — not the
    // pass-1 skip that happens to sit ahead of it in the array.
    expect(refusal).toBe("Insufficient stock for Widget. Available: 1, Requested: 2");
  });

  it("TIER 2: a failed[] entry's error, when no short line was reported", () => {
    const refusal = primaryRefusal({
      skipped: [{ reason: "unmapped", details: "Item is not mapped to an internal product" }],
      failed: [
        { error: "Product with ID 999 not found" },
        { error: "Item not found in order" },
      ],
    });

    expect(refusal).toBe("Product with ID 999 not found");
  });

  it("TIER 3: the first OTHER skip that has details", () => {
    const refusal = primaryRefusal({
      skipped: [
        { reason: "already_fulfilled" },
        { reason: "user_skipped", details: "Item is unmapped and user chose to skip" },
      ],
      failed: [],
    });

    // Scanned for one that explains itself — not the first entry, which has
    // nothing to say beyond its class name.
    expect(refusal).toBe("Item is unmapped and user chose to skip");
  });

  it("TIER 4: the bare reason, when no entry carries details at all", () => {
    const refusal = primaryRefusal({
      skipped: [{ reason: "already_fulfilled" }, { reason: "unmapped" }],
      failed: [],
    });

    expect(refusal).toBe("already_fulfilled");
  });

  it("returns null ONLY on an empty envelope — never undefined (DCc-10)", () => {
    const empty = primaryRefusal({ skipped: [], failed: [] });

    expect(empty).toBeNull();
    // The callers spell their fallback with `??`, which undefined would also
    // satisfy — so the pin is on the exact value, not on falsiness.
    expect(empty).not.toBeUndefined();
    expect(primaryRefusal({})).toBeNull();
    expect(primaryRefusal(null)).toBeNull();
    expect(primaryRefusal(undefined)).toBeNull();
  });

  it("ignores empty strings rather than surfacing a blank refusal", () => {
    // A blank sentence would ride straight through `?? 'the order could not be
    // fulfilled'` and reach the operator as an empty toast description.
    const refusal = primaryRefusal({
      skipped: [{ reason: "insufficient_stock", details: "   " }, { reason: "unmapped" }],
      failed: [{ error: "" }],
    });

    // Falls all the way to tier 4 and answers the first skip's class name —
    // thin, but true, and never null while the envelope has entries in it.
    expect(refusal).toBe("insufficient_stock");
  });
});
