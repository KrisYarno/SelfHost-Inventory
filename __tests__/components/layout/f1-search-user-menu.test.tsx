/** @jest-environment jsdom */
//
// Facelift F1-5 (plan 2026-11-18-facelift-f1 REV 2; FL-A-4, FL-A-16) — the
// header controls' two variants.
//
// GlobalSearch:
//   - `icon` (the phone header): a 44 x 44 icon button labelled `Search`;
//   - `bar` (the desktop sidebar): full width (`w-full justify-between`),
//     labelled `Search (Cmd+K)`.
//   The shell renders BOTH (CSS shows one), so only the `bar` binds Cmd+K —
//   before, every instance did, and one keypress opened two dialogs.
//
// UserMenu `compact` (the phone header): a 44 x 44 avatar labelled
// `Account menu`; the name and the role appear only inside the menu, so the
// header no longer widens with them. Without `compact` it is unchanged.

import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "kristopher@example.com", isAdmin: true } } }),
  signOut: jest.fn(),
}));
jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }));

import { GlobalSearch } from "@/components/layout/global-search";
import { UserMenu } from "@/components/layout/user-menu";

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const pressCmdK = () => fireEvent.keyDown(document, { key: "k", metaKey: true });

beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ products: [] }) })) as unknown as typeof fetch;
});

describe("F1-5 — GlobalSearch variants", () => {
  it("`icon`: a 44 x 44 icon button labelled `Search`, which opens the search", () => {
    withQuery(<GlobalSearch variant="icon" />);
    const button = screen.getByRole("button", { name: "Search" });
    expect(classesOf(button)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
    expect(button).toHaveTextContent("");
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search products...")).toBeInTheDocument();
  });

  it("`bar`: full width, labelled `Search (Cmd+K)`", () => {
    withQuery(<GlobalSearch variant="bar" />);
    const bar = screen.getByRole("button", { name: "Search (Cmd+K)" });
    expect(classesOf(bar)).toEqual(expect.arrayContaining(["w-full", "justify-between"]));
  });

  it("Cmd+K is bound ONCE: with both variants mounted, one keypress opens one dialog", () => {
    withQuery(
      <>
        <GlobalSearch variant="bar" />
        <GlobalSearch variant="icon" />
      </>
    );
    pressCmdK();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("the `icon` variant does not bind Cmd+K at all", () => {
    withQuery(<GlobalSearch variant="icon" />);
    pressCmdK();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("F1-5 — UserMenu compact", () => {
  it("is a 44 x 44 avatar labelled `Account menu`, with no name or role in the header", () => {
    render(<UserMenu compact />);
    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(classesOf(trigger)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
    expect(trigger).toHaveTextContent(/^KR$/);
    expect(screen.queryByText("kristopher")).toBeNull();
    expect(screen.queryByText("Admin")).toBeNull();
  });

  it("shows the name and the role inside the menu", async () => {
    const user = userEvent.setup();
    render(<UserMenu compact />);
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("kristopher")).toBeInTheDocument();
    expect(within(menu).getByText("Admin")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "My Account" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Theme" })).toBeInTheDocument();
  });

  it("without `compact`, the trigger still shows the name and the role (unchanged)", () => {
    render(<UserMenu />);
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
    const trigger = screen.getByRole("button");
    expect(within(trigger).getByText("kristopher")).toBeInTheDocument();
    expect(within(trigger).getByText("Admin")).toBeInTheDocument();
  });
});
