/** @jest-environment jsdom */
//
// Facelift F2-6 — the stock figure shared by the row, tile and table (plan
// 2026-11-19-facelift-f2: F2-6 as amended by A3 -> B12, A15, A24, B9).
//   - the total (`text-base font-semibold tabular-nums`, foreground colour);
//     `—` for null, aria-hidden, with NO extra screen-reader text (B12);
//   - the state word: a StatusBadge per state and tone; `ok` has none; the
//     state is read from the response, never recomputed (A24);
//   - the here line: only with a confirmed location AND a matching echo;
//     `{n} here`, `No record here` for null (A15), `0 here` for a 0 row;
//   - `undefined` fields render NOTHING: no `—` and no `0` (A18 via B9);
//   - A17: the F2b files import `@/lib/stock-threshold` TYPE-ONLY.
//   - FR1-14 (REV 7): `STOCK_STATE_WORDS` is the ONE map of the five words
//     (`ok` -> `OK`); the badges read it, and so does the list's CSV
//     (product-list-optimized.test pins that the CSV's words equal these).

import * as React from "react";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { render, screen } from "@testing-library/react";
import { ProductStock, STOCK_STATE_WORDS } from "@/components/products/product-stock";
import { toneClasses } from "@/components/ui/tone-classes";
import type { ProductWithQuantity } from "@/types/product";

type Figure = Pick<ProductWithQuantity, "totalQuantity" | "hereQuantity" | "stockState">;
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

function renderStock(
  product: Figure,
  { here = 1, selected = 1 as number | null, showHere }: { here?: number | null; selected?: number | null; showHere?: boolean } = {}
) {
  return render(
    <ProductStock
      id="fig"
      product={product}
      hereLocationId={here}
      selectedLocationId={selected}
      showHere={showHere}
    />
  );
}

describe("F2-6 — the state word", () => {
  it.each([
    ["low", "warning", "Low"],
    ["out", "negative", "Out"],
    ["below-zero", "negative", "Below zero"],
    ["no-record", "neutral", "No record"],
  ] as const)("%s -> a %s StatusBadge reading %s", (state, tone, word) => {
    renderStock({ totalQuantity: state === "no-record" ? null : 3, hereQuantity: 1, stockState: state });
    const badge = screen.getByText(word, { exact: true });
    const cls = classesOf(badge);
    expect(cls).toEqual(expect.arrayContaining(toneClasses[tone].split(" ")));
    expect(cls).toContain("text-xs");
    expect(cls).toContain("rounded-full"); // StatusBadge
  });

  it("ok -> no badge at all", () => {
    const { container } = renderStock({ totalQuantity: 48, hereQuantity: 4, stockState: "ok" });
    for (const word of ["Low", "Out", "Below zero", "No record"]) {
      expect(screen.queryByText(word)).toBeNull();
    }
    expect(container.querySelector(".rounded-full")).toBeNull();
  });

  it("A24: the state is READ from the response, never recomputed (a 0 total sent as ok shows no Out)", () => {
    renderStock({ totalQuantity: 0, hereQuantity: 0, stockState: "ok" });
    expect(screen.queryByText("Out")).toBeNull();
    renderStock({ totalQuantity: 500, hereQuantity: 0, stockState: "low" });
    expect(screen.getByText("Low")).toBeInTheDocument();
  });
});

describe("F2-6 — the total", () => {
  it("a number at text-base font-semibold tabular-nums in the foreground colour", () => {
    renderStock({ totalQuantity: 48, hereQuantity: 4, stockState: "low" });
    expect(classesOf(screen.getByText("48", { exact: true }))).toEqual(
      expect.arrayContaining(["text-base", "font-semibold", "tabular-nums", "text-foreground"])
    );
  });

  it("0 renders as 0 (a real 0 row)", () => {
    renderStock({ totalQuantity: 0, hereQuantity: 0, stockState: "out" });
    expect(screen.getByText("0", { exact: true })).toBeInTheDocument();
  });

  it("negative totals render as written", () => {
    renderStock({ totalQuantity: -3, hereQuantity: -3, stockState: "below-zero" });
    expect(screen.getByText("-3", { exact: true })).toBeInTheDocument();
  });

  it("null -> an aria-hidden — and NO extra screen-reader text or aria-label; the No record badge carries it (B12)", () => {
    const { container } = renderStock({ totalQuantity: null, hereQuantity: null, stockState: "no-record" });
    const dash = screen.getByText("—");
    expect(dash).toHaveAttribute("aria-hidden", "true");
    expect(classesOf(dash)).toEqual(expect.arrayContaining(["text-base", "font-semibold", "tabular-nums"]));
    expect(container.querySelector("[aria-label]")).toBeNull();
    expect(container.querySelector(".sr-only")).toBeNull();
    expect(screen.queryByText(/no stock record/i)).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByText("No record", { exact: true })).toBeInTheDocument();
  });
});

describe("F2-6 / A15 — the here line", () => {
  it("{n} here with a confirmed location and a matching echo, in text-xs text-muted-foreground", () => {
    renderStock({ totalQuantity: 48, hereQuantity: 4, stockState: "ok" }, { here: 7, selected: 7 });
    const line = screen.getByText("4 here", { exact: true });
    expect(classesOf(line)).toEqual(expect.arrayContaining(["text-xs", "text-muted-foreground"]));
  });

  it("0 here for a 0 row", () => {
    renderStock({ totalQuantity: 48, hereQuantity: 0, stockState: "ok" });
    expect(screen.getByText("0 here", { exact: true })).toBeInTheDocument();
  });

  it("No record here for null (A15 replaces REV 1's `None here`)", () => {
    renderStock({ totalQuantity: 48, hereQuantity: null, stockState: "ok" });
    expect(screen.getByText("No record here", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/none here/i)).toBeNull();
  });

  it("hidden with NO confirmed location", () => {
    renderStock({ totalQuantity: 48, hereQuantity: 4, stockState: "ok" }, { here: null, selected: null });
    expect(screen.queryByText(/here$/)).toBeNull();
  });

  it("hidden when the echo does not match the confirmed location (placeholder data from another location)", () => {
    renderStock({ totalQuantity: 48, hereQuantity: 4, stockState: "ok" }, { here: 1, selected: 2 });
    expect(screen.queryByText(/here$/)).toBeNull();
  });

  it("hidden when the answer carries no echo (null) though a location is confirmed", () => {
    renderStock({ totalQuantity: 48, hereQuantity: null, stockState: "ok" }, { here: null, selected: 2 });
    expect(screen.queryByText(/here$/)).toBeNull();
  });

  it("hidden with showHere={false} (the table's Stock cell; Here is its own column)", () => {
    renderStock({ totalQuantity: 48, hereQuantity: 4, stockState: "ok" }, { showHere: false });
    expect(screen.queryByText(/here$/)).toBeNull();
    expect(screen.getByText("48")).toBeInTheDocument();
  });
});

describe("B12 — the figure's words stay apart in an accessible description", () => {
  it("even with every element laid out inline (no element-boundary spacing): 48 Low 4 here", () => {
    // jsdom computes a <div> as display:block, which dom-accessibility-api
    // already pads with spaces; a browser may treat the inline-flex badge as
    // inline-level and join "48Low". Model that worst case with a stylesheet.
    const style = document.createElement("style");
    style.textContent = "div, span { display: inline; }";
    document.head.appendChild(style);
    try {
      render(
        <>
          <button type="button" aria-describedby="fig">Adjust</button>
          <ProductStock id="fig" product={{ totalQuantity: 48, hereQuantity: 4, stockState: "low" }} hereLocationId={1} selectedLocationId={1} />
        </>
      );
      expect(getComputedStyle(screen.getByText("Low")).display).toBe("inline");
      expect(screen.getByRole("button", { name: "Adjust" })).toHaveAccessibleDescription("48 Low 4 here");
    } finally {
      style.remove();
    }
  });
});

describe("B9 (A18) — undefined fields render NOTHING", () => {
  it("all three undefined -> nothing rendered at all", () => {
    const { container } = renderStock({});
    expect(container).toBeEmptyDOMElement();
  });

  it("an undefined total -> no — and no 0 (the badge still shows)", () => {
    renderStock({ stockState: "low" });
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByText("Low")).toBeInTheDocument();
  });

  it("an undefined stockState -> no badge; an undefined hereQuantity -> no here line", () => {
    const { container } = renderStock({ totalQuantity: 5 });
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(container.querySelector(".rounded-full")).toBeNull();
    expect(screen.queryByText(/here$/)).toBeNull();
  });
});

describe("A17 — the F2b files import @/lib/stock-threshold TYPE-ONLY", () => {
  const FILES = [
    "components/products/product-stock.tsx",
    "components/products/product-actions-menu.tsx",
    "components/products/product-row.tsx",
    "components/products/product-grid-tile.tsx",
    "components/products/product-table.tsx",
    "hooks/use-long-press.ts",
  ];

  /** Every import / export-from / dynamic import / require of the helper, with whether it is type-only. */
  function helperImports(rel: string): Array<{ text: string; typeOnly: boolean }> {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const out: Array<{ text: string; typeOnly: boolean }> = [];
    const isHelper = (n: ts.Node | undefined) => !!n && ts.isStringLiteral(n) && n.text === "@/lib/stock-threshold";
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && isHelper(n.moduleSpecifier)) {
        out.push({ text: n.getText(sf), typeOnly: !!n.importClause?.isTypeOnly });
      } else if (ts.isExportDeclaration(n) && isHelper(n.moduleSpecifier)) {
        out.push({ text: n.getText(sf), typeOnly: n.isTypeOnly });
      } else if (ts.isCallExpression(n) && isHelper(n.arguments[0])) {
        out.push({ text: n.getText(sf), typeOnly: false }); // require() / import()
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  it.each(FILES)("%s has no value import of the helper", (rel) => {
    for (const imp of helperImports(rel)) expect(imp).toEqual({ text: imp.text, typeOnly: true });
  });

  it("ProductStock's one import of the helper is the StockState type", () => {
    expect(helperImports("components/products/product-stock.tsx")).toEqual([
      { text: 'import type { StockState } from "@/lib/stock-threshold";', typeOnly: true },
    ]);
  });
});

describe("FR1-14 — ONE map of state words", () => {
  it("STOCK_STATE_WORDS is exactly the five words, with ok -> OK", () => {
    expect(STOCK_STATE_WORDS).toEqual({
      ok: "OK",
      low: "Low",
      out: "Out",
      "below-zero": "Below zero",
      "no-record": "No record",
    });
  });

  it.each(["low", "out", "below-zero", "no-record"] as const)("the %s badge reads STOCK_STATE_WORDS[%s]", (state) => {
    renderStock({ totalQuantity: state === "no-record" ? null : 3, hereQuantity: 1, stockState: state });
    expect(screen.getByText(STOCK_STATE_WORDS[state], { exact: true })).toBeInTheDocument();
  });

  it("the words live in ONE place: no other component spells the badge map out", () => {
    const stock = fs.readFileSync(path.join(process.cwd(), "components/products/product-stock.tsx"), "utf8");
    // Each word appears once in the stock figure's source: in the exported map.
    for (const word of ['"Below zero"', '"No record"']) {
      expect(stock.split(word).length - 1).toBe(1);
    }
    const list = fs.readFileSync(path.join(process.cwd(), "components/products/product-list-optimized.tsx"), "utf8");
    expect(list).not.toMatch(/\bSTATE_WORDS\s*[:=]/);
    expect(list).not.toMatch(/"Below zero"|"No record"/);
    expect(list).toMatch(/import \{ STOCK_STATE_WORDS \} from "\.\/product-stock";/);
  });
});
