/**
 * Shared, typed navigation config consumed by BOTH navs:
 *   - the mobile dock (grouped 6-slot speed-dial), and
 *   - the desktop sidebar (a flat vertical list via `flattenNav`).
 *
 * Modeling the top-level entries as a discriminated union keeps gating logic
 * (`adminOnly`) and group membership in ONE place so the two consumers can
 * never drift. See the mobile-nav-analytics-polish design doc
 * ("Design Review Resolutions 2026-06-08") for the locked 6-slot grouping
 * and the group-vs-direct-link icon assignments.
 */

import {
  BarChart3,
  Boxes,
  ClipboardList,
  Home,
  Inbox,
  NotebookPen,
  Package,
  PackageCheck,
  PackageOpen,
  Settings,
  ShoppingCart,
  Sparkles,
  Tags,
  Truck,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A direct, navigable leaf. Used as both a top-level slot and a group child. */
export type NavLink = {
  kind: "link";
  name: string;
  href: string;
  icon: LucideIcon;
  /** Human label (pill / sidebar text). Often equals `name`. */
  label: string;
  /** When true, only render for admins. */
  adminOnly?: boolean;
};

/**
 * A workflow group. On mobile it expands (speed-dial) into its `children`;
 * on desktop it is flattened into those children. Groups are never themselves
 * a navigation target.
 */
export type NavGroup = {
  kind: "group";
  /** Stable key for React keys + active-route matching. */
  key: string;
  label: string;
  icon: LucideIcon;
  /** Link-shaped leaves. */
  children: NavLink[];
  /** When true, the whole group is admin-only. */
  adminOnly?: boolean;
};

/** A top-level slot: either a direct link or an expandable group. */
export type NavItem = NavLink | NavGroup;

// ---------------------------------------------------------------------------
// Config — the 6 top-level slots, IN ORDER
// ---------------------------------------------------------------------------

export const navConfig: readonly NavItem[] = [
  {
    kind: "group",
    key: "fulfill",
    label: "Fulfill",
    icon: PackageCheck,
    children: [
      // Workbench = the one-by-one order-PACKING flow; Orders is its explicit
      // alternative (see the design doc's IA note). Both ungated.
      { kind: "link", name: "Workbench", href: "/workbench", icon: Home, label: "Workbench" },
      { kind: "link", name: "Orders", href: "/orders", icon: ShoppingCart, label: "Orders" },
    ],
  },
  {
    kind: "link",
    name: "Inventory",
    href: "/inventory",
    icon: Warehouse,
    label: "Inventory",
  },
  {
    kind: "group",
    key: "stock-ops",
    label: "Stock Ops",
    icon: Boxes,
    children: [
      { kind: "link", name: "Stocker", href: "/stocker", icon: Truck, label: "Stocker" },
      // W1-4b: the SHIPMENT-grain receiving surface, adjacent to Pre-Staging —
      // the ITEM-grain queue it deliberately does NOT replace (plan REV-2). A
      // box is logged in Pre-Staging and attributed to a receipt here; both
      // stay reachable, and both are ungated (receiving is dock work).
      { kind: "link", name: "Receiving", href: "/receiving", icon: Inbox, label: "Receiving" },
      { kind: "link", name: "Pre-Staging", href: "/pre-staging", icon: PackageOpen, label: "Pre-Staging" },
      { kind: "link", name: "Journal", href: "/journal", icon: ClipboardList, label: "Journal" },
    ],
  },
  {
    kind: "group",
    key: "catalog",
    label: "Catalog",
    icon: Tags,
    children: [
      { kind: "link", name: "Products", href: "/products", icon: Package, label: "Products" },
      // Full "Price Board" label (the sidebar name); "Prices" was only the
      // cramped flat-dock label that this redesign retires.
      { kind: "link", name: "Price Board", href: "/scratchpad", icon: NotebookPen, label: "Price Board" },
    ],
  },
  {
    kind: "link",
    name: "Analytics",
    href: "/analytics",
    icon: BarChart3,
    label: "Analytics",
  },
  {
    kind: "link",
    name: "Admin",
    href: "/admin",
    icon: Settings,
    label: "Admin",
    adminOnly: true,
  },
] as const;

// ---------------------------------------------------------------------------
// Desktop-only leaves (Lane 4 spec §10 R-A3)
// ---------------------------------------------------------------------------

/**
 * Leaf links that appear ONLY in the desktop sidebar, appended after the shared
 * {@link navConfig}. They are deliberately NOT part of the mobile 6-slot dock
 * law: the dock stays EXACTLY the 6 `navConfig` slots (test-enforced), and the
 * Assistant reaches mobile via URL / the analytics-hub link in v1. Dock
 * promotion is a v2 decision gated on usage evidence.
 *
 * Consumed ONLY by {@link SidebarNav} — never by the mobile dock, never mixed
 * into `navConfig`.
 */
export const desktopOnlyNav: readonly NavLink[] = [
  {
    kind: "link",
    name: "Assistant",
    href: "/assistant",
    icon: Sparkles,
    label: "Assistant",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers — shared gating so both consumers agree
// ---------------------------------------------------------------------------

/**
 * Filter the top-level slots for a given `isAdmin`, AND prune `adminOnly`
 * children inside any surviving group. Returns fresh group objects (children
 * arrays copied) so callers never mutate the shared config.
 */
export function filterNav(items: readonly NavItem[], isAdmin: boolean): NavItem[] {
  const result: NavItem[] = [];
  for (const item of items) {
    if (item.adminOnly && !isAdmin) continue;
    if (item.kind === "group") {
      const children = item.children.filter((c) => !(c.adminOnly && !isAdmin));
      result.push({ ...item, children });
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Flatten the config into the ordered list of VISIBLE leaf links for the
 * desktop sidebar: groups are expanded to their (gated) children, direct
 * links pass through, and `adminOnly` items/children are dropped when
 * `!isAdmin`. Order is preserved (slot order, then child order within groups).
 */
export function flattenNav(items: readonly NavItem[], isAdmin: boolean): NavLink[] {
  const flat: NavLink[] = [];
  for (const item of filterNav(items, isAdmin)) {
    if (item.kind === "group") flat.push(...item.children);
    else flat.push(item);
  }
  return flat;
}
