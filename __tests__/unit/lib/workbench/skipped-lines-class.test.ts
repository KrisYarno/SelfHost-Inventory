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
import { classifySkippedLine } from "@/lib/workbench/skipped-lines";

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
