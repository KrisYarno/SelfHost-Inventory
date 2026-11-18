/** @jest-environment jsdom */
//
// Facelift F1-1 (plan 2026-11-18-facelift-f1 REV 2; FL-D-8, FL-A-4, FL-B-8;
// G1-1 = OC1-1; DESIGN.md §4.5) — a 44 px MINIMUM on phones.
//
// Below `md` every Button size (but `compact`), SelectTrigger and SelectItem,
// TabsTrigger, and the dropdown menu's items carry `max-md:min-h-11`: a
// minimum, never an exact height. A caller's `h-14` / `h-12` / `h-auto` still
// renders as written, and a caller's `h-7` still reaches 44 px on a phone.
//
// The opt-outs are named, not general:
//   - `size="compact"` (no phone growth) on exactly three dense row actions;
//   - `max-md:min-h-0 max-md:min-w-0` on the calendar's day and nav buttons and
//     on every clear (X) button absolutely positioned inside an input.

import * as React from "react";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { render, screen } from "@testing-library/react";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "@/tailwind.config";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { ExternalOrderCard } from "@/components/orders/external-order-card";
import type { ExternalOrder } from "@/types/external-orders";

const FLOOR = "max-md:min-h-11";
const OPT_OUT = ["max-md:min-h-0", "max-md:min-w-0"];
const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

beforeAll(() => {
  // Radix Select / DropdownMenu need these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

describe("F1-1 — the Button sizes", () => {
  it("default, sm, lg and icon carry the exact contract strings; compact does not grow", () => {
    const size = (s: "default" | "sm" | "lg" | "icon" | "compact") =>
      buttonVariants({ variant: null, size: s }).split(/\s+/);
    const tail = (s: "default" | "sm" | "lg" | "icon" | "compact", n: number) => size(s).slice(-n).join(" ");
    expect(tail("default", 4)).toBe("h-9 max-md:min-h-11 px-4 py-2");
    expect(tail("sm", 6)).toBe("h-8 max-md:min-h-11 max-md:min-w-11 rounded-md px-3 text-xs");
    expect(tail("lg", 4)).toBe("h-10 max-md:min-h-11 rounded-md px-8");
    expect(tail("icon", 4)).toBe("h-9 w-9 max-md:min-h-11 max-md:min-w-11");
    expect(tail("compact", 4)).toBe("h-8 rounded-md px-3 text-xs");
    expect(size("compact").some((c) => c.startsWith("max-md:"))).toBe(false);
  });

  it("tailwind-merge keeps max-md:min-h-11 beside a caller's h-7 (and drops h-9)", () => {
    render(<Button className="h-7">Go</Button>);
    const cls = classesOf(screen.getByRole("button", { name: "Go" }));
    expect(cls).toEqual(expect.arrayContaining(["h-7", FLOOR]));
    expect(cls).not.toContain("h-9");
  });

  it("a caller's h-14 / h-auto still renders as written (the floor is a minimum)", () => {
    render(
      <>
        <Button size="icon" className="h-14 w-14">Fab</Button>
        <Button className="h-auto">Card</Button>
      </>
    );
    const fab = classesOf(screen.getByRole("button", { name: "Fab" }));
    expect(fab).toEqual(expect.arrayContaining(["h-14", "w-14", FLOOR, "max-md:min-w-11"]));
    expect(fab).not.toContain("h-9");
    const card = classesOf(screen.getByRole("button", { name: "Card" }));
    expect(card).toEqual(expect.arrayContaining(["h-auto", FLOOR]));
  });

  it("the compiled CSS emits min-height: 2.75rem inside @media not all and (min-width: 768px)", async () => {
    // Compiled from the class lists the primitives actually produce (a Button
    // of each growing size, and the calendar day's opt-out), with the
    // project's own Tailwind config.
    const day = new Date(2026, 10, 17);
    const { unmount } = render(<Calendar mode="single" selected={day} month={day} />);
    const dayClasses = screen.getByRole("gridcell", { name: "18" }).getAttribute("class");
    unmount();
    const lists = [
      buttonVariants({ size: "default" }),
      buttonVariants({ size: "sm" }),
      buttonVariants({ size: "icon" }),
      dayClasses,
    ].join(" ");
    const result = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [{ raw: `<div class="${lists}"></div>`, extension: "html" }],
        corePlugins: { preflight: false },
      }),
    ]).process("@tailwind utilities;", { from: undefined });
    const root = postcss.parse(result.css);
    const found: Record<string, string> = {};
    root.walkAtRules("media", (at) => {
      if (at.params !== "not all and (min-width: 768px)") return;
      at.walkRules((rule) => {
        rule.walkDecls((d) => {
          found[`${rule.selector}|${d.prop}`] = d.value;
        });
      });
    });
    expect(found[".max-md\\:min-h-11|min-height"]).toBe("2.75rem");
    expect(found[".max-md\\:min-w-11|min-width"]).toBe("2.75rem");
    expect(found[".max-md\\:min-h-0|min-height"]).toBe("0px");
  });
});

describe("F1-1 — no primitive sets an EXACT phone height", () => {
  it("every max-md:h- class in components/ui is max-md:h-auto, and only TabsList has it", () => {
    const dir = path.join(ROOT, "components/ui");
    const hits: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(tsx?|css)$/.test(f)) continue;
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const m of src.match(/max-md:h-[^\s"'`]+/g) ?? []) hits.push(`${f}:${m}`);
    }
    // `max-md:h-auto` RELEASES TabsList's h-9 so its 44 px triggers fit; it is
    // the only phone-height class allowed, and no primitive has a fixed one.
    expect(hits).toEqual(["tabs.tsx:max-md:h-auto"]);
  });
});

describe("F1-1 — the other primitives", () => {
  it("SelectTrigger and SelectItem carry the floor", () => {
    render(
      <Select defaultOpen value="a">
        <SelectTrigger aria-label="Pick">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>
    );
    // The open listbox hides the rest of the page from the a11y tree.
    expect(classesOf(screen.getByRole("combobox", { name: "Pick", hidden: true }))).toContain(FLOOR);
    expect(classesOf(screen.getByRole("option", { name: "Alpha" }))).toContain(FLOOR);
  });

  it("TabsList releases its height on phones; TabsTrigger carries the floor", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">One</TabsTrigger>
        </TabsList>
      </Tabs>
    );
    const list = classesOf(screen.getByRole("tablist"));
    expect(list).toEqual(expect.arrayContaining(["h-9", "max-md:h-auto"]));
    expect(classesOf(screen.getByRole("tab", { name: "One" }))).toContain(FLOOR);
  });

  it("DropdownMenuItem, CheckboxItem, RadioItem and SubTrigger carry the floor", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Plain</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Check</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="r">
            <DropdownMenuRadioItem value="r">Radio</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(classesOf(screen.getByRole("menuitem", { name: "Plain" }))).toContain(FLOOR);
    expect(classesOf(screen.getByRole("menuitemcheckbox", { name: "Check" }))).toContain(FLOOR);
    expect(classesOf(screen.getByRole("menuitemradio", { name: "Radio" }))).toContain(FLOOR);
    expect(classesOf(screen.getByRole("menuitem", { name: "More" }))).toContain(FLOOR);
  });

  it("AlertDialogAction and AlertDialogCancel grow through buttonVariants", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Sure?</AlertDialogTitle>
          <AlertDialogDescription>Really.</AlertDialogDescription>
          <AlertDialogCancel>No</AlertDialogCancel>
          <AlertDialogAction>Yes</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    );
    expect(classesOf(screen.getByRole("button", { name: "Yes" }))).toContain(FLOOR);
    expect(classesOf(screen.getByRole("button", { name: "No" }))).toContain(FLOOR);
  });

  it("the calendar's day and nav buttons opt out (a compact date grid does not grow in F1)", () => {
    const day = new Date(2026, 10, 17);
    render(<Calendar mode="single" selected={day} month={day} />);
    const cell = classesOf(screen.getByRole("gridcell", { name: "18" }));
    expect(cell).toEqual(expect.arrayContaining(OPT_OUT));
    expect(cell).not.toContain(FLOOR);
    const navs = screen.getAllByRole("button", { name: /month/i });
    expect(navs.length).toBe(2);
    for (const nav of navs) {
      expect(classesOf(nav)).toEqual(expect.arrayContaining(OPT_OUT));
      expect(classesOf(nav)).not.toContain(FLOOR);
    }
  });

  it("Input: no height change; the one focus ring (ring-ring on the background)", () => {
    render(<Input aria-label="Field" />);
    const cls = classesOf(screen.getByRole("textbox", { name: "Field" }));
    expect(cls).toEqual(expect.arrayContaining(["h-9", "focus-visible:ring-ring", "focus-visible:ring-offset-background"]));
    expect(cls.some((c) => c.includes("sky-400") || c.includes("slate-900"))).toBe(false);
    expect(cls.some((c) => c.startsWith("max-md:"))).toBe(false);
  });
});

describe("F1-1 — ExternalOrderCard's button is not height-capped", () => {
  it("keeps h-auto (no h-9, no max height) and only gains the minimum", () => {
    const order = {
      id: "o1",
      orderNumber: "1001",
      internalStatus: "pending",
      stockedOut: false,
      items: [{ quantity: 2, fulfilledQty: 0 }],
      createdAt: new Date(2026, 10, 17).toISOString(),
      externalCreatedAt: null,
      customerName: "A",
      customerEmail: null,
      total: 10,
      currency: "USD",
      integration: null,
    } as unknown as ExternalOrder;
    render(<ExternalOrderCard order={order} onSelect={() => {}} />);
    const cls = classesOf(screen.getByRole("button"));
    expect(cls).toEqual(expect.arrayContaining(["h-auto", FLOOR]));
    expect(cls).not.toContain("h-9");
    expect(cls.some((c) => /^(max-md:)?(max-h-|h-\d)/.test(c))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The opt-out sites, read off the source: each named JSX <Button> carries its
// opt-out. A site is found by what makes it that site (its file, and the
// absolutely positioned clear button inside an input wrapper / the row action
// the plan names), so a moved line still resolves and a lost class fails.
// ---------------------------------------------------------------------------

type ButtonSite = { file: string; line: number; attrs: Record<string, string> };

function buttons(rel: string): ButtonSite[] {
  const src = read(rel);
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: ButtonSite[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === "Button") {
      const attrs: Record<string, string> = {};
      for (const p of n.attributes.properties) {
        if (!ts.isJsxAttribute(p)) continue;
        const name = p.name.getText(sf);
        const init = p.initializer;
        attrs[name] = !init
          ? "true"
          : ts.isStringLiteral(init)
            ? init.text
            : init.getText(sf);
      }
      out.push({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, attrs });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const CLEAR_SITES: Array<[string, number]> = [
  ["components/orders/order-filters.tsx", 2],
  ["components/products/product-list-optimized.tsx", 1],
  ["app/(app)/stocker/page.tsx", 1],
  // Found by the implementer's sweep (the plan's "any other Button absolutely
  // positioned inside an input wrapper"): the analytics hub's search clear.
  ["components/analytics/analytics-hub.tsx", 1],
];

describe("F1-1 — every clear (X) button inside an input opts out", () => {
  it.each(CLEAR_SITES)("%s: its %i absolutely positioned clear button(s) carry max-md:min-h-0 max-md:min-w-0", (file, n) => {
    const sites = buttons(file).filter((b) => /\babsolute\b/.test(b.attrs.className ?? ""));
    expect(sites).toHaveLength(n);
    for (const s of sites) {
      expect((s.attrs.className ?? "").split(/\s+/)).toEqual(expect.arrayContaining(OPT_OUT));
    }
  });

  it("no other absolutely positioned Button exists in app/ or components/ without the opt-out", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (rel.endsWith(".tsx")) files.push(rel);
      }
    };
    walk("app");
    walk("components");
    const offenders = files
      .flatMap((f) => buttons(f))
      .filter((b) => /\babsolute\b/.test(b.attrs.className ?? ""))
      .filter((b) => !OPT_OUT.every((c) => (b.attrs.className ?? "").split(/\s+/).includes(c)))
      .map((b) => `${b.file}:${b.line}`);
    expect(offenders).toEqual([]);
  });
});

describe("F1-1 — size=\"compact\" is used at exactly the three named row actions", () => {
  it("the Thresholds row button, the order sheet's Map row action and the user table's row menu", () => {
    const thresholds = buttons("app/(app)/admin/settings/thresholds/page.tsx").filter((b) => b.attrs.size === "compact");
    expect(thresholds).toHaveLength(1);
    expect(thresholds[0].attrs["aria-label"]).toContain("Edit per-location minimums for");

    const sheet = buttons("components/orders/external-order-details-sheet.tsx").filter((b) => b.attrs.size === "compact");
    expect(sheet).toHaveLength(1);
    expect(sheet[0].attrs.className).toBe("h-6 px-2 text-xs");

    const users = buttons("components/admin/user-table.tsx").filter((b) => b.attrs.size === "compact");
    expect(users).toHaveLength(1);
    expect(users[0].attrs.className).toBe("h-8 w-8 p-0");
  });

  it("no other file uses size=\"compact\"", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (rel.endsWith(".tsx")) files.push(rel);
      }
    };
    walk("app");
    walk("components");
    const users = files.filter((f) => buttons(f).some((b) => b.attrs.size === "compact")).sort();
    expect(users).toEqual([
      "app/(app)/admin/settings/thresholds/page.tsx",
      "components/admin/user-table.tsx",
      "components/orders/external-order-details-sheet.tsx",
    ]);
  });
});
