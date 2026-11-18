//
// Facelift F1-8 (plan 2026-11-18-facelift-f1 REV 2; FL-A-18, FL-D-21; OC1-22,
// G1-21) — landmarks: the shell's `<main>` is the ONLY main.
//
// Pages rendered their own `<main>` inside the shell's (dashboard, settings,
// products, account, admin/reports) and the Journal marked a div
// `role="main"` — several mains in one document, against the shell invariant
// (DESIGN.md §3.1). Those became `<div>`s; the Journal's list became a
// `<section aria-labelledby="products-heading">`, and its own skip link stays.
// The shell itself is pinned rendered (__tests__/components/layout/f1-shell.test.tsx);
// this scan pins that no page or component adds another.

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(rel);
    return entry.name.endsWith(".tsx") ? [rel] : [];
  });
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SOURCES = [...tsxFiles("app"), ...tsxFiles("components")];

describe("F1-8 — one main", () => {
  it("only the shell renders a <main> element", () => {
    const withMain = SOURCES.filter((rel) => /<main[\s>]/.test(read(rel)));
    expect(withMain).toEqual([path.join("components", "layout", "app-shell.tsx")]);
  });

  it("nothing claims role=\"main\"", () => {
    expect(SOURCES.filter((rel) => /role=["']main["']/.test(read(rel)))).toEqual([]);
  });

  it.each([
    "app/(app)/dashboard/page.tsx",
    "app/(app)/settings/page.tsx",
    "app/(app)/products/page.tsx",
    "app/(app)/account/page.tsx",
    "app/(app)/admin/reports/page.tsx",
  ])("%s has no <main> of its own", (rel) => {
    expect(read(rel)).not.toMatch(/<\/?main[\s>]/);
  });

  it("the Journal's list is a section labelled by its heading, and its own skip link is kept", () => {
    const journal = read("app/(app)/journal/page.tsx");
    expect(journal).toContain('<section aria-labelledby="products-heading"');
    expect(journal).toContain('<a href="#products-heading" className="skip-link">');
    expect(journal).toContain('<CardTitle id="products-heading">Products</CardTitle>');
  });
});
