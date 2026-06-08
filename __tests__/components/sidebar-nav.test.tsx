/** @jest-environment jsdom */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { SidebarNav } from "@/components/layout/sidebar-nav";

// usePathname drives active state; pick a route that exists in the flat list.
jest.mock("next/navigation", () => ({ usePathname: () => "/workbench" }));

// useSession drives admin gating; default to a non-admin resolved session.
let mockSession: { data: unknown } = { data: { user: { isAdmin: false } } };
jest.mock("next-auth/react", () => ({ useSession: () => mockSession }));

// Render next/link as a plain anchor.
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
  mockSession = { data: { user: { isAdmin: false } } };
});

test("non-admin sidebar renders the ungated Orders link to /orders, but no Admin link", () => {
  render(<SidebarNav />);
  // Orders is now a Fulfill child (ungated) -> present for everyone.
  expect(screen.getByRole("link", { name: /orders/i })).toHaveAttribute("href", "/orders");
  // Admin stays admin-only.
  expect(screen.queryByRole("link", { name: /admin/i })).toBeNull();
});

test("admin sidebar renders the Admin link to /admin", () => {
  mockSession = { data: { user: { isAdmin: true } } };
  render(<SidebarNav />);
  expect(screen.getByRole("link", { name: /admin/i })).toHaveAttribute("href", "/admin");
});

test("sidebar renders Analytics -> /analytics and Price Board -> /scratchpad for a non-admin", () => {
  render(<SidebarNav />);
  expect(screen.getByRole("link", { name: /analytics/i })).toHaveAttribute("href", "/analytics");
  expect(screen.getByRole("link", { name: /price board/i })).toHaveAttribute("href", "/scratchpad");
});
