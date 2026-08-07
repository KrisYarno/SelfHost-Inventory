/**
 * @jest-environment node
 *
 * lib/assistant/tool-presentation.ts — the DISCLOSURE-ROW copy contract (spec C4, UI
 * half; review F12). These strings are what a reader sees under "Looked up sales" — a
 * disclosure row that omits the real window or location is a silent scope claim.
 *
 * Pins (spec C4 §Presentation):
 *  - get_sales / get_movement_series: relativeDays renders "last N days"; ABSENT dates
 *    render the tool's REAL default ("last 30 days (default)").
 *  - get_operations renders from `windowDays` (default 90) — it does NOT take
 *    relativeDays, so a "last 30 days" phrase there would be a false disclosure.
 *  - get_stock has NO default window (it pages all recorded snapshot days), so absent
 *    dates render "all recorded days (paged)" — NEVER "last 30 days".
 *  - compare_periods renders BOTH periods (it rendered neither).
 *  - movement / stock render `location #N`.
 *
 * This module is CLIENT-SAFE: no prisma, no tools.ts. The import list here is the pin.
 */

import { TOOL_PRESENTATION } from "@/lib/assistant/tool-presentation";

const summarize = (tool: string, input: unknown): string =>
  TOOL_PRESENTATION[tool].summarizeArgs(input);

describe("dateRangePhrase — explicit dates win over every default", () => {
  it.each(["get_sales", "get_movement_series", "get_stock"])(
    "%s renders an explicit from/to range",
    (tool) => {
      expect(summarize(tool, { productId: 1, from: "2026-01-01", to: "2026-06-01" })).toContain(
        "2026-01-01 to 2026-06-01",
      );
    },
  );

  it.each(["get_sales", "get_movement_series", "get_stock"])(
    "%s renders an open-ended from / to",
    (tool) => {
      expect(summarize(tool, { productId: 1, from: "2026-01-01" })).toContain("since 2026-01-01");
      expect(summarize(tool, { productId: 1, to: "2026-06-01" })).toContain("through 2026-06-01");
    },
  );
});

describe("get_sales disclosure row (spec C4)", () => {
  it("renders relativeDays as 'last N days'", () => {
    expect(summarize("get_sales", { relativeDays: 7 })).toContain("last 7 days");
  });

  it("renders the REAL default window when no dates are given", () => {
    expect(summarize("get_sales", { groupBy: "product" })).toContain("last 30 days (default)");
  });

  it("still renders product + grain alongside the window", () => {
    const s = summarize("get_sales", { productId: 12, groupBy: "day" });
    expect(s).toContain("product #12");
    expect(s).toContain("by day");
    expect(s).toContain("last 30 days (default)");
  });
});

describe("get_movement_series disclosure row (spec C4)", () => {
  it("renders relativeDays, the default window, and the location", () => {
    expect(summarize("get_movement_series", { relativeDays: 90 })).toContain("last 90 days");
    expect(summarize("get_movement_series", {})).toContain("last 30 days (default)");
    expect(summarize("get_movement_series", { locationId: 4 })).toContain("location #4");
  });

  it("keeps the receipts / groupBy discriminant", () => {
    expect(summarize("get_movement_series", { receipts: true })).toContain("receipts");
    expect(summarize("get_movement_series", { groupBy: "week" })).toContain("by week");
  });
});

describe("get_stock disclosure row — NO default window (spec C4)", () => {
  it("renders 'all recorded days (paged)' when no dates are given", () => {
    expect(summarize("get_stock", { productId: 1 })).toContain("all recorded days (paged)");
  });

  // The load-bearing negative: get_stock has no 30-day fallback, so borrowing the
  // sales/movement default here would be a NEW false disclosure.
  it("NEVER says 'last 30 days'", () => {
    for (const input of [{ productId: 1 }, { productId: 1, locationId: 2 }, {}]) {
      expect(summarize("get_stock", input)).not.toContain("last 30 days");
    }
  });

  it("renders the location scope", () => {
    expect(summarize("get_stock", { productId: 1, locationId: 2 })).toContain("location #2");
  });
});

describe("get_operations disclosure row — windowDays, not relativeDays (spec C4)", () => {
  it("renders the REAL default window (90) when windowDays is absent", () => {
    expect(summarize("get_operations", {})).toContain("90-day window (default)");
  });

  it("renders an explicit windowDays without the '(default)' marker", () => {
    const s = summarize("get_operations", { windowDays: 30 });
    expect(s).toContain("30-day window");
    expect(s).not.toContain("(default)");
  });

  // get_operations does not accept relativeDays or from/to — rendering "last N days"
  // from an ignored argument would disclose a window the tool never queried.
  it("never renders a 'last N days' phrase", () => {
    expect(summarize("get_operations", { relativeDays: 7 })).not.toMatch(/last \d+ days/);
    expect(summarize("get_operations", { from: "2026-01-01", to: "2026-02-01" })).not.toContain(
      "2026-01-01",
    );
  });

  it("still renders the product scope", () => {
    expect(summarize("get_operations", { productId: 9, windowDays: 30 })).toContain("product #9");
  });
});

describe("compare_periods disclosure row renders BOTH periods (spec C4)", () => {
  it("renders each period's explicit range", () => {
    const s = summarize("compare_periods", {
      metric: "sales_units",
      periodA: { from: "2026-01-01", to: "2026-01-31" },
      periodB: { from: "2026-02-01", to: "2026-02-28" },
    });
    expect(s).toContain("2026-01-01 to 2026-01-31");
    expect(s).toContain("2026-02-01 to 2026-02-28");
    expect(s).toContain("sales units");
  });

  it("renders relativeDays per period and the shared default when absent", () => {
    expect(
      summarize("compare_periods", {
        metric: "outbound_units",
        periodA: { relativeDays: 7 },
        periodB: { relativeDays: 14 },
      }),
    ).toContain("last 7 days vs last 14 days");
    expect(
      summarize("compare_periods", { metric: "outbound_units", periodA: {}, periodB: {} }),
    ).toContain("last 30 days (default) vs last 30 days (default)");
  });

  it("tolerates missing/partial period args without throwing (streamed tool args)", () => {
    expect(() => summarize("compare_periods", { metric: "sales_units" })).not.toThrow();
    expect(() => summarize("compare_periods", null)).not.toThrow();
  });

  it("still renders the optional product scope", () => {
    expect(
      summarize("compare_periods", {
        metric: "sales_units",
        periodA: { relativeDays: 7 },
        periodB: { relativeDays: 7 },
        productId: 3,
      }),
    ).toContain("product #3");
  });
});

// ---------------------------------------------------------------------------
// OC-5 — the arguments that change WHICH POPULATION an answer covers. Each of these
// rendered nothing, so a bounded/expanded call was disclosed exactly like the plain
// one: "Looked up sales, last 30 days" for a catalog-wide zero-row sweep, and a bare
// "Built the reorder report" for a five-product sizing.
// ---------------------------------------------------------------------------

describe("OC-5 — scope-changing arguments are disclosed", () => {
  it("get_sales renders includeZeroRows (the answer covers the whole approved catalog)", () => {
    const s = summarize("get_sales", { groupBy: "product", includeZeroRows: true });
    expect(s).toContain("incl. zero-sales products");
    expect(s).toContain("by product");
    // Absent/false renders nothing — the phrase is a claim, not decoration.
    expect(summarize("get_sales", { groupBy: "product" })).not.toContain("zero-sales");
    expect(summarize("get_sales", { includeZeroRows: false })).not.toContain("zero-sales");
  });

  // QA-3: the OC-5 rule's one missed population argument. `includeArchived` widens the
  // lookup from the live catalog to live + DELETED products, so a search that surfaces a
  // retired product rendered exactly like one that could not have.
  it("find_product renders includeArchived (the answer covers deleted products too)", () => {
    const s = summarize("find_product", { query: "tirz", includeArchived: true });
    expect(s).toContain("incl. deleted");
    expect(s).toContain("matching");
    // Absent/false renders nothing — the phrase is a claim about the population, not decoration.
    expect(summarize("find_product", { query: "tirz" })).not.toContain("deleted");
    expect(summarize("find_product", { query: "tirz", includeArchived: false })).not.toContain("deleted");
    // Streamed junk is not an explicit true (the `flag` posture every other arg uses).
    expect(summarize("find_product", { query: "tirz", includeArchived: "yes" })).not.toContain("deleted");
    // ...and the flag alone still renders, so a mid-stream call is never a bare label.
    expect(summarize("find_product", { includeArchived: true })).toBe("incl. deleted");
  });

  it("get_movement_series renders breakdownBy and the productIds set", () => {
    const s = summarize("get_movement_series", {
      breakdownBy: "product",
      productIds: [7, 8, 9],
      relativeDays: 14,
    });
    expect(s).toContain("per product");
    expect(s).toContain("products #7, #8, #9");
    expect(s).toContain("last 14 days");
    // receipts still wins the shape slot; the plain series is unchanged.
    expect(summarize("get_movement_series", { receipts: true })).toContain("receipts");
    expect(summarize("get_movement_series", { groupBy: "week" })).toContain("by week");
    expect(summarize("get_movement_series", {})).not.toContain("per product");
  });

  it("compare_periods renders groupBy:'product' and direction", () => {
    const s = summarize("compare_periods", {
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      groupBy: "product",
      direction: "increase",
    });
    expect(s).toContain("per product");
    expect(s).toContain("increase only");
    // Totals mode says neither.
    const totals = summarize("compare_periods", {
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
    });
    expect(totals).not.toContain("per product");
    expect(totals).not.toContain("only");
  });

  it("reorder_report renders productIds / includeHealthy (it rendered nothing at all)", () => {
    expect(summarize("reorder_report", { productIds: [3, 12] })).toContain("products #3, #12");
    expect(summarize("reorder_report", { includeHealthy: true })).toContain("incl. healthy");
    const both = summarize("reorder_report", { productIds: [4], includeHealthy: true });
    expect(both).toBe("products #4, incl. approaching, incl. healthy");
  });

  // FD-8: this case used to PIN THE BUG — it asserted "" for a call that omits
  // includeOkay and "" again for includeOkay:true, i.e. it locked in the very omission
  // OC-5 set out to fix. includeOkay defaults to TRUE at the tool boundary, so passing
  // FALSE narrows the report to the urgent worklist and drops every APPROACHING row.
  // A disclosure row that reads the same either way hides which rows are missing.
  it("reorder_report renders includeOkay BOTH ways (population-changing, so never silent)", () => {
    // Explicitly narrowed: the APPROACHING rows are gone, and the row says so.
    expect(summarize("reorder_report", { includeOkay: false })).toBe("worklist only");
    // Omitted or true — the same population, stated the same way.
    expect(summarize("reorder_report", {})).toBe("incl. approaching");
    expect(summarize("reorder_report", { includeOkay: true })).toBe("incl. approaching");
    // The two states must never render alike, whatever else rides along.
    const narrowed = summarize("reorder_report", { productIds: [4], includeOkay: false });
    const wide = summarize("reorder_report", { productIds: [4], includeOkay: true });
    expect(narrowed).not.toBe(wide);
    expect(narrowed).toBe("products #4, worklist only");
  });

  it("id lists stay inert for junk / partial streamed args", () => {
    // The default population phrase rides along; only the ID LIST is under test here, and
    // a junk/empty list must contribute NOTHING to it.
    expect(summarize("reorder_report", { productIds: "nonsense" })).toBe("incl. approaching");
    expect(summarize("reorder_report", { productIds: [] })).toBe("incl. approaching");
    expect(summarize("reorder_report", { productIds: [1, "x", null] })).toBe(
      "products #1, incl. approaching",
    );
    // Streamed junk in includeOkay is NOT an explicit false: it reads as the default.
    expect(summarize("reorder_report", { includeOkay: "nope" })).toBe("incl. approaching");
    expect(summarize("get_movement_series", { productIds: [Number.NaN] })).not.toContain("products");
  });
});

describe("every registered presentation entry stays inert + total", () => {
  it("summarizeArgs never throws for an empty / null / junk input", () => {
    for (const [name, p] of Object.entries(TOOL_PRESENTATION)) {
      expect(() => p.summarizeArgs({})).not.toThrow();
      expect(() => p.summarizeArgs(null)).not.toThrow();
      expect(() => p.summarizeArgs("nonsense")).not.toThrow();
      expect(typeof p.summarizeArgs({})).toBe("string");
      expect(p.pendingLabel.length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
