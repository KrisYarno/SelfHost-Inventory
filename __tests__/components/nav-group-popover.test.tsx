/** @jest-environment jsdom */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavGroupPopover } from "@/components/layout/nav-group-popover";
import type { NavGroup } from "@/lib/nav-config";
import { Boxes, Truck, Tag, ClipboardList } from "lucide-react";

// usePathname drives the active-route treatment; default to a route that does
// NOT match any child so the group reads inactive unless a test overrides it.
let mockPathname = "/dashboard";
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));

// Render next/link as a plain anchor (the repo has no link manual mock).
// forwardRef so the component's ref to the first pill attaches cleanly.
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

const group: NavGroup = {
  kind: "group",
  key: "stock-ops",
  label: "Stock Ops",
  icon: Boxes,
  children: [
    { kind: "link", name: "Stocker", href: "/stocker", icon: Truck, label: "Stocker" },
    { kind: "link", name: "Labeling", href: "/labeling", icon: Tag, label: "Labeling" },
    { kind: "link", name: "Journal", href: "/journal", icon: ClipboardList, label: "Journal" },
  ],
};

const adminGroup: NavGroup = {
  kind: "group",
  key: "admin-stuff",
  label: "Admin Stuff",
  icon: Boxes,
  children: [
    { kind: "link", name: "Stocker", href: "/stocker", icon: Truck, label: "Stocker" },
    { kind: "link", name: "Secret", href: "/secret", icon: Truck, label: "Secret", adminOnly: true },
  ],
};

beforeEach(() => {
  mockPathname = "/dashboard";
});

function renderPopover(props: Partial<React.ComponentProps<typeof NavGroupPopover>> = {}) {
  const onToggle = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    <NavGroupPopover
      group={group}
      isAdmin={false}
      isOpen={false}
      onToggle={onToggle}
      onClose={onClose}
      align="left"
      {...props}
    />,
  );
  return { onToggle, onClose, ...utils };
}

test("trigger renders with aria-haspopup and aria-expanded=false when closed", () => {
  renderPopover();
  const trigger = screen.getByRole("button", { name: /stock ops/i });
  expect(trigger).toHaveAttribute("aria-haspopup", "true");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Closed: children are not rendered as links.
  expect(screen.queryByRole("link", { name: /stocker/i })).toBeNull();
});

test("clicking the trigger calls onToggle", async () => {
  const user = userEvent.setup();
  const { onToggle } = renderPopover();
  await user.click(screen.getByRole("button", { name: /stock ops/i }));
  expect(onToggle).toHaveBeenCalledTimes(1);
});

test("when open, children render as links with their labels and aria-expanded=true", () => {
  renderPopover({ isOpen: true });
  expect(screen.getByRole("button", { name: /stock ops/i })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("link", { name: /stocker/i })).toHaveAttribute("href", "/stocker");
  expect(screen.getByRole("link", { name: /labeling/i })).toHaveAttribute("href", "/labeling");
  expect(screen.getByRole("link", { name: /journal/i })).toHaveAttribute("href", "/journal");
});

test("adminOnly children are filtered out for non-admins", () => {
  renderPopover({ group: adminGroup, isOpen: true });
  expect(screen.getByRole("link", { name: /^stocker$/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /secret/i })).toBeNull();
});

test("adminOnly children render for admins", () => {
  renderPopover({ group: adminGroup, isOpen: true, isAdmin: true });
  expect(screen.getByRole("link", { name: /secret/i })).toHaveAttribute("href", "/secret");
});

test("Escape calls onClose when open", async () => {
  const user = userEvent.setup();
  const { onClose } = renderPopover({ isOpen: true });
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("clicking the backdrop calls onClose", async () => {
  const user = userEvent.setup();
  const { onClose } = renderPopover({ isOpen: true });
  await user.click(screen.getByTestId("nav-popover-backdrop"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("group trigger shows the active treatment when a child route is current", () => {
  mockPathname = "/stocker";
  renderPopover();
  // aria-current marks the active group on the trigger.
  expect(screen.getByRole("button", { name: /stock ops/i })).toHaveAttribute("aria-current", "true");
});

test("the open pill matching the current route gets aria-current=page", () => {
  mockPathname = "/journal";
  renderPopover({ isOpen: true });
  expect(screen.getByRole("link", { name: /journal/i })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: /stocker/i })).not.toHaveAttribute("aria-current");
});
