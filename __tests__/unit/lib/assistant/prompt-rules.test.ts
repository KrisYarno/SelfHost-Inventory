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
import { assistantTools } from "@/lib/assistant/tools";

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
  // Owning tasks FLIPPED these pins as they landed the capability + its routing bullet:
  // 2.3 -> compare_periods groupBy:'product' ("started/stopped moving" bullet);
  // 2.4 -> movement breakdownBy/productIds (set-question bullet, movement half);
  // 3.2 -> includeArchived/lifecycle ("Deleted products" bullet) — the LAST one.
  // Every W0 negative pin is now a positive assertion below; nothing is outstanding.
  it("every routing affordance the prompt names is a landed capability", () => {
    // `.shape` is the same raw-object access the MCP adapter uses (see the gate case in
    // toolsuite-gates.test.ts) — inputSchema is typed as the ZodType supertype.
    const shapeOf = (name: string) =>
      (assistantTools[name].inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(shapeOf("find_product")).toHaveProperty("includeArchived");
    expect(shapeOf("get_movement_series")).toHaveProperty("breakdownBy");
    expect(shapeOf("compare_periods")).toHaveProperty("groupBy");
  });
});

describe("C13 routing (Task 3.2): deleted products have a stated, TRUE policy", () => {
  it("names the history tools that return them automatically, labeled", () => {
    expect(p).toContain("Deleted products");
    expect(p).toContain("lifecycle:'deleted'");
    expect(p).toContain("find_product needs includeArchived:true");
  });

  it("keeps the as-of CATALOG exception and the current-state exclusion honest", () => {
    expect(p).toContain("as-of for a SPECIFIC productId");
    expect(p).toContain("as-of CATALOG page stays active-only");
    // The failure mode this closes: the model claiming it has no visibility at all.
    expect(p).toContain("say so rather than 'no visibility'");
  });
});

describe("C10 routing (Task 2.4): the movement half of the set question", () => {
  it("offers get_movement_series breakdownBy:'product' (+ productIds) beside the sales half", () => {
    expect(p).toContain("get_movement_series breakdownBy:'product'");
    expect(p).toContain("productIds to narrow it to a named set");
    // The rule the capability exists to enforce still stands.
    expect(p).toContain("Never loop a per-product tool");
  });
});

describe("C9 routing (Task 2.3): the started/stopped-moving question has a home", () => {
  it("routes it to compare_periods groupBy:'product', with the unranked caveat", () => {
    expect(p).toContain("started/stopped moving");
    expect(p).toContain("compare_periods groupBy:'product'");
    // The REV-4 erratum, carried into the prompt: unranked = unknown base, not growth.
    expect(p).toContain("unknown-base, never as growth");
    // ...and the started-moving case is the MEASURED-zero ranked row, not an unranked one.
    expect(p).toContain("measured a of 0");
  });
});
