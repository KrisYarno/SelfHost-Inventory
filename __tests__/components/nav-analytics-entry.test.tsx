/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { MobileNav } from "@/components/layout/mobile-nav";

jest.mock("next/navigation", () => ({ usePathname: () => "/workbench" }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { isAdmin: false } } }) }));

test("sidebar shows an Analytics link to /analytics for non-admin approved users", () => {
  render(<SidebarNav />);
  const link = screen.getByRole("link", { name: /analytics/i });
  expect(link).toHaveAttribute("href", "/analytics");
});

test("mobile nav shows an Analytics link to /analytics", () => {
  render(<MobileNav />);
  const link = screen.getByRole("link", { name: /analytics/i });
  expect(link).toHaveAttribute("href", "/analytics");
});
