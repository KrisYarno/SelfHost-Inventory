/** @jest-environment jsdom */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileNav } from "@/components/layout/mobile-nav";

// usePathname drives the active-route treatment; default to a route that does
// NOT match any group child so groups read inactive unless a test overrides it.
let mockPathname = "/dashboard";
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));

// useSession drives admin gating; default to a non-admin resolved session.
// Individual tests override the return value before rendering.
let mockSession: { data: unknown } = { data: { user: { isAdmin: false } } };
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

// Render next/link as a plain anchor (the repo has no link manual mock).
// forwardRef so the popover's ref to the first pill attaches cleanly.
jest.mock("next/link", () => {
  const Mock = React.forwardRef<HTMLAnchorElement, any>(
    ({ children, href, ...rest }, ref) => (
      <a ref={ref} href={typeof href === "string" ? href : "#"} {...rest}>
        {children}
      </a>
    ),
  );
  Mock.displayName = "NextLinkMock";
  return { __esModule: true, default: Mock };
});

beforeEach(() => {
  mockPathname = "/dashboard";
  mockSession = { data: { user: { isAdmin: false } } };
});

test("non-admin dock renders the three group triggers + direct Inventory/Analytics links, no Admin", () => {
  render(<MobileNav />);

  // Groups are <button> triggers (speed-dial), not links.
  expect(screen.getByRole("button", { name: /fulfill/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /stock ops/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /catalog/i })).toBeInTheDocument();

  // Direct slots are links.
  expect(screen.getByRole("link", { name: /inventory/i })).toHaveAttribute("href", "/inventory");
  expect(screen.getByRole("link", { name: /analytics/i })).toHaveAttribute("href", "/analytics");

  // Admin is admin-only -> absent for a non-admin.
  expect(screen.queryByRole("link", { name: /admin/i })).toBeNull();
});

test("admin dock renders the Admin link to /admin", () => {
  mockSession = { data: { user: { isAdmin: true } } };
  render(<MobileNav />);
  expect(screen.getByRole("link", { name: /admin/i })).toHaveAttribute("href", "/admin");
});

test("Orders is reachable by a non-admin via the Fulfill group (ungate on mobile)", async () => {
  const user = userEvent.setup();
  render(<MobileNav />);

  // Closed: no Orders link yet.
  expect(screen.queryByRole("link", { name: /orders/i })).toBeNull();

  await user.click(screen.getByRole("button", { name: /fulfill/i }));

  expect(screen.getByRole("link", { name: /orders/i })).toHaveAttribute("href", "/orders");
});

test("opening a group sets aria-expanded=true; opening a second closes the first (single-open)", async () => {
  const user = userEvent.setup();
  render(<MobileNav />);

  const fulfill = screen.getByRole("button", { name: /fulfill/i });
  const stockOps = screen.getByRole("button", { name: /stock ops/i });

  expect(fulfill).toHaveAttribute("aria-expanded", "false");
  expect(stockOps).toHaveAttribute("aria-expanded", "false");

  await user.click(fulfill);
  expect(fulfill).toHaveAttribute("aria-expanded", "true");

  // Opening Stock Ops must close Fulfill.
  await user.click(stockOps);
  expect(stockOps).toHaveAttribute("aria-expanded", "true");
  expect(fulfill).toHaveAttribute("aria-expanded", "false");
});

test("group-active: on /stocker the Stock Ops trigger gets aria-current", () => {
  mockPathname = "/stocker";
  render(<MobileNav />);
  expect(screen.getByRole("button", { name: /stock ops/i })).toHaveAttribute("aria-current", "true");
});

test("a route change closes an open group (navigating via a direct link/pill)", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<MobileNav />);

  await user.click(screen.getByRole("button", { name: /fulfill/i }));
  expect(screen.getByRole("button", { name: /fulfill/i })).toHaveAttribute("aria-expanded", "true");

  // Simulate a client navigation (the dial sits above the dismiss backdrop, so a
  // direct-link tap navigates without first closing the dial — the pathname
  // effect must close it so it never lingers over the new page).
  mockPathname = "/inventory";
  rerender(<MobileNav />);
  expect(screen.getByRole("button", { name: /fulfill/i })).toHaveAttribute("aria-expanded", "false");
});
