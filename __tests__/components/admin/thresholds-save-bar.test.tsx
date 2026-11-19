/** @jest-environment jsdom */
//
// Facelift F1-3 (plan 2026-11-18-facelift-f1 REV 2; FL-D-17) — the Thresholds
// save bar is the shared StickyActionBar.
//
// It used to be `fixed` with an inline `bottom: calc(inset + 4.75rem)` and no
// breakpoint: a 19 px gap above the dock on a phone, and on desktop (no dock)
// it floated 76 px above the bottom of the window with content visible under
// it. It now sits on the dock through --dock-height (0 at md and up), passes
// its own conditional amber "pending" classes through unchanged, and the page
// keeps its own bottom padding (`pb-44 sm:pb-28`).
//
// F1-1 is pinned here too: the list view's per-row button is `size="compact"`.

import * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

const DATA = {
  products: [
    {
      id: 1,
      name: "Widget A",
      combinedMinimum: null,
      totalStock: 4,
      perLocation: [{ locationId: 7, locationName: "Main", quantity: 4, minQuantity: 2 }],
    },
  ],
  locations: [{ id: 7, name: "Main" }],
  lowStockDefault: 10,
};

jest.mock("@/hooks/use-admin", () => ({
  useThresholds: () => ({ data: DATA, isLoading: false, isError: false, dataUpdatedAt: 1, errorUpdatedAt: 0 }),
  useSaveThresholds: () => ({ isPending: false, mutateAsync: jest.fn() }),
  useSaveLowStockDefault: () => ({ isPending: false, mutateAsync: jest.fn() }),
}));

import MinimumSettingsPage from "@/app/(app)/admin/settings/thresholds/page";

const AMBER = ["border-amber-300", "bg-amber-50/90", "dark:border-amber-700", "dark:bg-amber-900/30"];
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("Thresholds — the save bar is the StickyActionBar (F1-3)", () => {
  it("sits above the dock through the variable, fixed at every width; no inline bottom; the page keeps pb-44 sm:pb-28", () => {
    const { container } = render(<MinimumSettingsPage />);
    const bar = screen.getByRole("region", { name: "Threshold changes" });
    const cls = classesOf(bar);
    expect(cls).toEqual(
      expect.arrayContaining([
        "fixed",
        "inset-x-0",
        "md:left-64",
        "bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom))]",
      ])
    );
    expect(bar.getAttribute("style")).toBeNull();
    // with nothing pending: today's quiet classes, and none of the amber
    expect(cls).toEqual(expect.arrayContaining(["border-border", "bg-background/90"]));
    for (const c of AMBER) expect(cls).not.toContain(c);
    expect(classesOf(container.firstElementChild as HTMLElement)).toEqual(
      expect.arrayContaining(["pb-44", "sm:pb-28"])
    );

    const [summary, actions] = Array.from((bar.firstElementChild as HTMLElement).children) as HTMLElement[];
    expect(summary.getAttribute("aria-live")).toBe("polite");
    expect(summary).toHaveTextContent("No changes");
    expect(within(actions).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual([
      "Undo",
      "Reset",
      "Save",
    ]);
  });

  it("an edit turns on the amber 'pending' classes, passed through unchanged", async () => {
    const user = userEvent.setup();
    render(<MinimumSettingsPage />);
    const input = screen.getByRole("spinbutton", { name: "Minimum for Widget A at Main" });
    await act(async () => {
      await user.clear(input);
      await user.type(input, "5");
    });
    const bar = screen.getByRole("region", { name: "Threshold changes" });
    expect(classesOf(bar)).toEqual(expect.arrayContaining(AMBER));
    expect(classesOf(bar)).not.toContain("bg-background/90");
    expect(within(bar).getByText(/changes? pending/)).toBeInTheDocument();
  });
});

describe("Thresholds — the list view's row button is size=compact (F1-1)", () => {
  it("does not grow on phones", async () => {
    const user = userEvent.setup();
    render(<MinimumSettingsPage />);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "List" }));
    });
    const row = screen.getByRole("button", { name: "Edit per-location minimums for Widget A" });
    const cls = classesOf(row);
    expect(cls).toEqual(expect.arrayContaining(["h-8", "px-3", "text-xs"]));
    expect(cls.some((c) => c.startsWith("max-md:"))).toBe(false);
    // ...while the page's other small buttons DO grow (the floor is the rule).
    const undo = within(screen.getByRole("region", { name: "Threshold changes" })).getByRole("button", { name: "Undo" });
    expect(classesOf(undo)).toEqual(expect.arrayContaining(["h-8", "max-md:min-h-11", "max-md:min-w-11"]));
  });
});

// Facelift FR1-6 (REV 6, OCR-3): the per-product drawer's sheet sat at
// `bottom-0`, UNDER the fixed dock on a phone — its last location rows and
// steppers hidden behind it — and its body could not scroll past it.
//
// Facelift FR2-5 (REV 8, FD1-5) supersedes FR1-6's offset: lifted above the
// dock, the drawer left the dock live — its backdrop, inside `main`, could not
// cover it, so one tap on a dock tab navigated away and threw the unsaved edits
// away. The drawer is now portaled to `document.body` at `z-[60]` (the dock is
// `z-50`), so its backdrop dims and blocks the dock, and the sheet goes back to
// `bottom-0` with the safe-area inset as padding. It still scrolls.
describe("Thresholds — the drawer covers the dock, and a tall drawer scrolls (FR2-5, FR1-6)", () => {
  async function openDrawer() {
    const user = userEvent.setup();
    // Inside a `main`, as the shell renders every page.
    render(
      <main>
        <MinimumSettingsPage />
      </main>
    );
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "List" }));
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Edit per-location minimums for Widget A" }));
    });
    // The drawer's own Close (the sheet's header) — the sheet is its parents.
    const close = screen.getByRole("button", { name: "Close" });
    const header = close.parentElement as HTMLElement;
    const sheet = header.parentElement as HTMLElement;
    const drawer = sheet.parentElement as HTMLElement;
    return { header, sheet, drawer };
  }

  it("the drawer is a child of document.body — not of main — at z-[60], above the dock's z-50", async () => {
    const { drawer } = await openDrawer();
    expect(drawer.parentElement).toBe(document.body);
    expect(document.querySelector("main")).not.toContainElement(drawer);
    const cls = classesOf(drawer);
    expect(cls).toEqual(expect.arrayContaining(["fixed", "inset-0", "z-[60]"]));
    expect(cls).not.toContain("z-50");
    // Its backdrop is the drawer's first child: it covers the whole window.
    expect(classesOf(drawer.firstElementChild as HTMLElement)).toEqual(
      expect.arrayContaining(["absolute", "inset-0"])
    );
  });

  it("the sheet sits at bottom-0 with the safe-area inset as padding, as a flex column", async () => {
    const { sheet } = await openDrawer();
    const cls = classesOf(sheet);
    expect(cls).toEqual(
      expect.arrayContaining([
        "absolute",
        "inset-x-0",
        "bottom-0",
        "pb-[env(safe-area-inset-bottom)]",
        "flex",
        "flex-col",
        "max-h-[90%]",
      ])
    );
    expect(cls).not.toContain("bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom))]");
  });

  it("its body is the part that scrolls: min-h-0 flex-1 overflow-y-auto", async () => {
    const { header } = await openDrawer();
    const body = header.nextElementSibling as HTMLElement;
    expect(body).toHaveTextContent("Low-stock alert threshold");
    expect(classesOf(body)).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]));
  });

  it("Close and the backdrop still close it", async () => {
    const user = userEvent.setup();
    const { drawer } = await openDrawer();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(document.body).not.toContainElement(drawer);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Edit per-location minimums for Widget A" }));
    });
    const reopened = screen.getByRole("button", { name: "Close" }).parentElement!.parentElement!.parentElement as HTMLElement;
    await act(async () => {
      await user.click(reopened.firstElementChild as HTMLElement);
    });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
