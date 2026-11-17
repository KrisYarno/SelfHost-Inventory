// @jest-environment node
//
// W2-1 ride-along (registered at W0.5-a) — the STRUCTURAL `class` field on
// UnmappedExternalItem.
//
// Until now the three classes the array mixes were re-DERIVED downstream from a
// heuristic: "no external product reference" meant mapped-but-not-loaded. That
// works only because the push site that omits the reference happens to be the
// one that means it. The hook already KNOWS which branch it took; the field
// records it instead of re-deducing it, and `classifySkippedLine` trusts the
// recorded value when it is there.
//
// The fallback stays for any line built without the field (a caller outside the
// hook, or a store snapshot that predates it) — deleting it would turn a
// missing field into a WRONG class rather than a degraded one.
import {
  SKIPPED_LINE_CLASSES,
  SKIPPED_LINE_COPY,
  SKIPPED_LINE_LABEL,
  SKIPPED_LINE_NOUN,
  classifySkippedLine,
} from "@/lib/workbench/skipped-lines";

describe("classifySkippedLine — the recorded class wins", () => {
  it("returns the structural class when the line carries one", () => {
    expect(classifySkippedLine({ class: "bundle" })).toBe("bundle");
    expect(classifySkippedLine({ class: "unavailable" })).toBe("unavailable");
    expect(classifySkippedLine({ class: "unmapped" })).toBe("unmapped");
  });

  it("trusts the recorded class over what the heuristic would have guessed", () => {
    // The heuristic reads "has an external reference" as `unmapped`; the hook
    // recorded `unavailable`. The hook knows which branch it took — it wins.
    expect(
      classifySkippedLine({ class: "unavailable", externalProductId: "wc-p-1" })
    ).toBe("unavailable");
  });

  it("falls back to the as-built heuristic when no class is recorded", () => {
    expect(classifySkippedLine({ isBundle: true })).toBe("bundle");
    expect(classifySkippedLine({})).toBe("unavailable");
    expect(classifySkippedLine({ externalProductId: "wc-p-1" })).toBe("unmapped");
    expect(classifySkippedLine({ externalVariantId: "wc-v-1" })).toBe("unmapped");
  });
});

// ---------------------------------------------------------------------------
// Facelift F0-1 (plan 2026-11-17-facelift-f0, part 1 + fold (a)): the FOURTH
// class. A mapped single whose product IS loaded but has nothing in stock at the
// selected location used to be dropped from every surface; it is now a skipped
// line of its own, stamped `'out-of-stock'` by the hook. The recorded class
// must win here exactly as the other three do — the heuristic below would call
// the same payload `unavailable` (no reference) or `unmapped` (a reference).
// ---------------------------------------------------------------------------

describe("F0-1 — the out-of-stock class", () => {
  it("the recorded 'out-of-stock' class wins over both heuristic answers", () => {
    expect(classifySkippedLine({ class: "out-of-stock" })).toBe("out-of-stock");
    expect(
      classifySkippedLine({ class: "out-of-stock", externalProductId: "wc-p-1" })
    ).toBe("out-of-stock");
  });

  it("carries its own copy, label and summary nouns, byte for byte", () => {
    expect(SKIPPED_LINE_COPY["out-of-stock"]).toBe("none in stock here — not deducted");
    expect(SKIPPED_LINE_LABEL["out-of-stock"]).toBe("Out of stock here");
    expect(SKIPPED_LINE_NOUN["out-of-stock"]).toEqual([
      "out-of-stock line",
      "out-of-stock lines",
    ]);
  });

  it("renders after the two unmapped classes and before the informational bundles", () => {
    expect(SKIPPED_LINE_CLASSES).toEqual(["unmapped", "unavailable", "out-of-stock", "bundle"]);
  });
});
