/** @jest-environment jsdom */
//
// Facelift F1-5 (plan 2026-11-18-facelift-f1 REV 2; FL-A-3; OC1-9, OC1-10,
// G1-13) — THE LOCATION CHIP. Every stock write lands at the selected location,
// so the chip always says which one that is, or that there is none:
//   - loading: a 44 px skeleton;
//   - failed with nothing loaded: a warning `Locations failed — Retry` (a
//     failed refresh over a loaded list keeps the chip as it was);
//   - zero locations: a muted `No locations`, with no menu;
//   - loaded, nothing selected: `Choose location` in the warning tone;
//   - loaded with a selection: `At: <name>`, labelled `At: <name>. Change location`.
// A change toasts `Now working at <name>.` from the change handler only — no
// Undo, no extra live region.
//
// Before: a 36 px unlabelled select that rendered NOTHING when the read
// failed or the list was empty, and changed silently.

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockToast = jest.fn();
const mockWarning = jest.fn();
jest.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => mockToast(...a), {
    warning: (...a: unknown[]) => mockWarning(...a),
  }),
}));

type Loc = { id: number; name: string };
type Ctx = {
  locations: Loc[];
  selectedLocation: Loc | null;
  selectedLocationId: number | null;
  setSelectedLocationId: jest.Mock;
  isLoading: boolean;
  loadFailed: boolean;
  retryLocations: jest.Mock;
};
let mockCtx: Ctx;
jest.mock("@/contexts/location-context", () => ({ useLocation: () => mockCtx }));

import { LocationSwitcher } from "@/components/layout/location-switcher";

const MAIN = { id: 1, name: "Main Warehouse" };
const BACK = { id: 2, name: "Back Room" };
const WARNING_TONE = ["bg-warning-muted", "text-warning-foreground", "border-warning-border"];
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

function ctx(over: Partial<Ctx>): Ctx {
  return {
    locations: [MAIN, BACK],
    selectedLocation: MAIN,
    selectedLocationId: MAIN.id,
    setSelectedLocationId: jest.fn(),
    isLoading: false,
    loadFailed: false,
    retryLocations: jest.fn(),
    ...over,
  };
}

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  mockToast.mockReset();
  mockWarning.mockReset();
  mockCtx = ctx({});
});

describe("F1-5 — the chip's states", () => {
  it("loading: a 44 px skeleton, and nothing to press", () => {
    mockCtx = ctx({ isLoading: true, locations: [], selectedLocation: null, selectedLocationId: null });
    const { container } = render(<LocationSwitcher />);
    const skeleton = container.firstElementChild as HTMLElement;
    expect(classesOf(skeleton)).toEqual(expect.arrayContaining(["animate-pulse", "h-11"]));
    expect(classesOf(skeleton)).not.toContain("h-10");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("failed with nothing loaded: a warning-tone `Locations failed — Retry` that reads again", async () => {
    const user = userEvent.setup();
    mockCtx = ctx({ loadFailed: true, locations: [], selectedLocation: null, selectedLocationId: null });
    render(<LocationSwitcher />);
    const retry = screen.getByRole("button", { name: "Locations failed — Retry" });
    expect(classesOf(retry)).toEqual(expect.arrayContaining([...WARNING_TONE, "min-h-11"]));
    await user.click(retry);
    expect(mockCtx.retryLocations).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("a failed refresh over a loaded list keeps the chip as it was", () => {
    mockCtx = ctx({ loadFailed: true });
    render(<LocationSwitcher />);
    expect(screen.getByRole("combobox", { name: "At: Main Warehouse. Change location" })).toBeInTheDocument();
    expect(screen.queryByText("Locations failed — Retry")).toBeNull();
  });

  it("zero locations loaded: a muted `No locations`, with no menu", () => {
    mockCtx = ctx({ locations: [], selectedLocation: null, selectedLocationId: null });
    const { container } = render(<LocationSwitcher />);
    expect(screen.getByText("No locations")).toBeInTheDocument();
    expect(classesOf(container.firstElementChild!)).toContain("text-muted-foreground");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("loaded with a selection: `At:` (muted) then the name (truncated), on a 44 px tinted trigger", () => {
    render(<LocationSwitcher />);
    const chip = screen.getByRole("combobox", { name: "At: Main Warehouse. Change location" });
    expect(classesOf(chip)).toEqual(
      expect.arrayContaining(["min-h-11", "bg-primary/15", "border-primary/40"])
    );
    const at = within(chip).getByText("At:");
    expect(classesOf(at)).toContain("text-muted-foreground");
    const name = within(chip).getByText("Main Warehouse");
    expect(classesOf(name)).toContain("truncate");
    // `At:` reads before the name, and the Building2 icon stays.
    expect(at.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip.querySelector("svg.lucide-building2, svg.lucide-building-2")).not.toBeNull();
  });

  it("loaded, nothing selected: `Choose location` in the warning tone, which opens the menu", async () => {
    const user = userEvent.setup();
    mockCtx = ctx({ selectedLocation: null, selectedLocationId: null });
    render(<LocationSwitcher />);
    const chip = screen.getByRole("combobox", { name: "Choose location" });
    expect(chip).toHaveTextContent("Choose location");
    expect(classesOf(chip)).toEqual(expect.arrayContaining([...WARNING_TONE, "min-h-11"]));
    expect(classesOf(chip)).not.toContain("bg-primary/15");

    await user.click(chip);
    expect(await screen.findByRole("option", { name: "Main Warehouse" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Back Room" })).toBeInTheDocument();
  });
});

describe("F1-5 — a change says where the user now works", () => {
  it("picks the location and toasts `Now working at <name>.` (id location-change, 5 s), with no Undo", async () => {
    const user = userEvent.setup();
    const { container } = render(<LocationSwitcher />);
    await user.click(screen.getByRole("combobox", { name: "At: Main Warehouse. Change location" }));
    await user.click(await screen.findByRole("option", { name: "Back Room" }));

    expect(mockCtx.setSelectedLocationId).toHaveBeenCalledWith(2);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith("Now working at Back Room.", {
      id: "location-change",
      duration: 5000,
    });
    // no Undo action, and no live region of the chip's own (sonner's announces it)
    const [, options] = mockToast.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty("action");
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it("a first choice from `Choose location` toasts too", async () => {
    const user = userEvent.setup();
    mockCtx = ctx({ selectedLocation: null, selectedLocationId: null });
    render(<LocationSwitcher />);
    await user.click(screen.getByRole("combobox", { name: "Choose location" }));
    await user.click(await screen.findByRole("option", { name: "Main Warehouse" }));
    expect(mockCtx.setSelectedLocationId).toHaveBeenCalledWith(1);
    expect(mockToast).toHaveBeenCalledWith("Now working at Main Warehouse.", {
      id: "location-change",
      duration: 5000,
    });
  });

  it("a selection changed from elsewhere (not the handler) toasts nothing", () => {
    const { rerender } = render(<LocationSwitcher />);
    mockCtx = ctx({ selectedLocation: BACK, selectedLocationId: BACK.id });
    rerender(<LocationSwitcher />);
    expect(screen.getByRole("combobox", { name: "At: Back Room. Change location" })).toBeInTheDocument();
    mockCtx = ctx({ selectedLocation: null, selectedLocationId: null });
    rerender(<LocationSwitcher />);
    expect(mockToast).not.toHaveBeenCalled();
  });
});
