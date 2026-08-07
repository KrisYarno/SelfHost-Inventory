/**
 * @jest-environment node
 *
 * C1 prompt rules (assistant quality+reach lane): the TRUTHFULNESS + ROUTING
 * additions that close the review-#3 failure classes — catalog-wide conclusions
 * drawn from a product-scoped call, asserted events no tool reported, "never/ever"
 * claims beyond the queried window, and per-product looping instead of one
 * server-ranked call.
 *
 * Assertions are WHITESPACE-COLLAPSED on purpose: the prompt is a \n-joined array
 * of ~78-char lines, so every multi-word phrase must survive natural wrapping.
 */

import { buildSystemPrompt } from "@/lib/assistant/prompt";

const p = buildSystemPrompt(new Date("2026-08-06T00:00:00Z")).replace(/\s+/g, " ");

describe("C1 TRUTHFULNESS rules", () => {
  it("forbids a catalog-wide conclusion from a product-scoped call", () => {
    expect(p).toContain("Never state a catalog-wide conclusion");
  });

  it("binds the model to what a tool returned — figures AND events", () => {
    expect(p).toContain("figures AND events");
  });

  it("states the 366-day reach WITHOUT claiming older history is unreachable", () => {
    expect(p).toContain("OLDER history is reachable with explicit from/to");
    expect(p).not.toMatch(/cannot see beyond/); // the REV-1 false claim must not ship
  });

  it("bans the 'new product' inference (tools cannot see creation dates)", () => {
    expect(p).toContain("never 'new product'");
  });
});

describe("C1 ROUTING rules", () => {
  it("routes SET/catalog questions to ONE grouped get_sales call, never a loop", () => {
    expect(p).toContain("groupBy:'product'");
    expect(p).toContain("Never loop a per-product tool");
  });
});

describe("W0 seam-fix: the prompt promises NO capability that does not exist yet", () => {
  // Owning tasks FLIP these pins when they land the capability + its routing bullet:
  // 2.3 -> compare_periods groupBy:'product' ("started/stopped moving" bullet);
  // 2.4 -> movement breakdownBy/productIds (set-question bullet, movement half);
  // 3.2 -> includeArchived/lifecycle ("Deleted products" bullet).
  it("does not mention W2/W3 arguments before their tasks land", () => {
    expect(p).not.toMatch(/breakdownBy/);
    expect(p).not.toMatch(/includeArchived/);
    expect(p).not.toMatch(/lifecycle:'deleted'/);
    expect(p).not.toMatch(/started\/stopped moving/);
  });
});
