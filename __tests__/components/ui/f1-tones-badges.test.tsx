/** @jest-environment jsdom */
//
// Facelift F1-2 (plan 2026-11-18-facelift-f1 REV 2; FL-A-9, FL-D-10, FL-B-4;
// G1-3..6) — readable badges.
//
//   - `toneClasses` and `StatusTone` live in `components/ui/tone-classes.ts`.
//     `status-badge.tsx` re-exports them; `badge.tsx` imports them from
//     tone-classes directly (never from status-badge: no circular import).
//   - Badge's warning / success / info variants ARE the shared tones
//     (warning / positive / info): readable text on a muted fill, not white or
//     pale text on a fill colour.
//   - StatusBadge's default size is 12/16 (`text-xs`, a size tailwind-merge
//     recognises), no longer `text-[11px]`.
//   - Skeleton fills with `bg-foreground/10` (its contrast is in f1-tokens).
//   - DataTable's grey text uses the theme tokens.

import * as React from "react";
import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react";
import * as Tones from "@/components/ui/tone-classes";
import * as StatusBadgeModule from "@/components/ui/status-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/ui/data-table";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("F1-2 — tone-classes.ts", () => {
  it("owns toneClasses; status-badge re-exports the very same object", () => {
    expect(Tones.toneClasses.warning).toBe("bg-warning-muted text-warning-foreground border border-warning-border");
    expect(StatusBadgeModule.toneClasses).toBe(Tones.toneClasses);
  });

  it("tone-classes.ts declares StatusTone and toneClasses; status-badge.tsx no longer declares them", () => {
    const tones = read("components/ui/tone-classes.ts");
    expect(tones).toMatch(/export type StatusTone =/);
    expect(tones).toMatch(/export const toneClasses: Record<StatusTone, string> =/);
    const status = read("components/ui/status-badge.tsx");
    expect(status).not.toMatch(/export type StatusTone =/);
    expect(status).not.toMatch(/export const toneClasses/);
    expect(status).toMatch(/from "@\/components\/ui\/tone-classes"/);
  });

  it("badge.tsx imports from tone-classes, never from status-badge (no circular import)", () => {
    const badge = read("components/ui/badge.tsx");
    expect(badge).toMatch(/import \{ toneClasses \} from "@\/components\/ui\/tone-classes"/);
    expect(badge).not.toMatch(/status-badge/);
    expect(read("components/ui/tone-classes.ts")).not.toMatch(/^import /m);
  });
});

describe("F1-2 — the Badge variants", () => {
  it.each([
    ["warning", "warning"],
    ["success", "positive"],
    ["info", "info"],
  ] as const)("%s uses toneClasses.%s", (variant, tone) => {
    const base = badgeVariants({ variant: null });
    expect(badgeVariants({ variant })).toBe(`${base.replace(/\s*$/, "")} ${Tones.toneClasses[tone]}`.trim());
    render(<Badge variant={variant}>{variant}</Badge>);
    const cls = classesOf(screen.getByText(variant));
    expect(cls).toEqual(expect.arrayContaining(Tones.toneClasses[tone].split(" ")));
    // the old fill-under-text pairs are gone
    expect(cls.some((c) => /^bg-(warning|success|info)\/90$/.test(c) || c === "text-white")).toBe(false);
  });
});

describe("F1-2 — StatusBadge's default size", () => {
  it("is px-2.5 py-0.5 text-xs, with no text-[11px]", () => {
    render(<StatusBadge>Tag</StatusBadge>);
    const cls = classesOf(screen.getByText("Tag"));
    expect(cls).toEqual(expect.arrayContaining(["px-2.5", "py-0.5", "text-xs"]));
    expect(cls).not.toContain("text-[11px]");
    expect(read("components/ui/status-badge.tsx")).not.toContain("text-[11px]");
  });

  it("the body size is unchanged", () => {
    render(<StatusBadge size="body">Label</StatusBadge>);
    expect(classesOf(screen.getByText("Label"))).toEqual(expect.arrayContaining(["px-3", "py-1", "text-sm"]));
  });
});

describe("F1-2 — Skeleton and DataTable", () => {
  it("Skeleton fills with bg-foreground/10, not bg-primary/10", () => {
    render(<Skeleton data-testid="sk" />);
    const cls = classesOf(screen.getByTestId("sk"));
    expect(cls).toContain("bg-foreground/10");
    expect(cls).not.toContain("bg-primary/10");
  });

  it("DataTable: the empty message is text-muted-foreground; headers are text-foreground; no grey", () => {
    const { unmount } = render(<DataTable data={[]} columns={[{ key: "a", header: "A" }]} emptyMessage="Nothing" />);
    expect(classesOf(screen.getByText("Nothing").parentElement!)).toContain("text-muted-foreground");
    unmount();
    render(<DataTable data={[{ a: "x" }]} columns={[{ key: "a", header: "Head" }]} />);
    expect(classesOf(screen.getByRole("columnheader", { name: "Head" }))).toContain("text-foreground");
    expect(read("components/ui/data-table.tsx")).not.toMatch(/text-gray-/);
  });
});
