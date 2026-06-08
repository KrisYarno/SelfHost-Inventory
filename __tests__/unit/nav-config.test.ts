/**
 * @jest-environment node
 *
 * T1 — shared grouped nav-config.
 * Asserts: the 6 top-level slots + their order; Orders is visible to a
 * non-admin (NOT adminOnly); Admin is adminOnly; group membership for
 * Fulfill / Stock Ops / Catalog; the flattenNav contract for both isAdmin
 * values; and that no group icon collides with a direct-link icon.
 */

import {
  navConfig,
  flattenNav,
  filterNav,
  type NavItem,
  type NavLink,
  type NavGroup,
} from "@/lib/nav-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isGroup = (item: NavItem): item is NavGroup => item.kind === "group";
const isLink = (item: NavItem): item is NavLink => item.kind === "link";

const groupByKey = (key: string): NavGroup => {
  const found = navConfig.find((i) => i.kind === "group" && i.key === key);
  if (!found || !isGroup(found)) {
    throw new Error(`expected a group with key "${key}"`);
  }
  return found;
};

// ---------------------------------------------------------------------------
// Top-level slots: count + order
// ---------------------------------------------------------------------------

describe("navConfig top-level slots", () => {
  it("has exactly 6 top-level slots in the locked order", () => {
    expect(navConfig).toHaveLength(6);
    expect(navConfig.map((i) => i.label)).toEqual([
      "Fulfill",
      "Inventory",
      "Stock Ops",
      "Catalog",
      "Analytics",
      "Admin",
    ]);
  });

  it("uses the right kind per slot (group / link / link / group … )", () => {
    expect(navConfig.map((i) => i.kind)).toEqual([
      "group", // Fulfill
      "link", // Inventory
      "group", // Stock Ops
      "group", // Catalog
      "link", // Analytics
      "link", // Admin
    ]);
  });

  it("points direct links at the expected hrefs", () => {
    const links = navConfig.filter(isLink);
    const byName = Object.fromEntries(links.map((l) => [l.name, l.href]));
    expect(byName).toMatchObject({
      Inventory: "/inventory",
      Analytics: "/analytics",
      Admin: "/admin",
    });
  });
});

// ---------------------------------------------------------------------------
// Admin gating: Orders ungated; Admin adminOnly
// ---------------------------------------------------------------------------

describe("admin gating", () => {
  it("does NOT mark Orders as adminOnly (Orders is ungated)", () => {
    const fulfill = groupByKey("fulfill");
    const orders = fulfill.children.find((c) => c.name === "Orders");
    expect(orders).toBeDefined();
    expect(orders?.adminOnly).toBeFalsy();
  });

  it("marks the Admin slot as adminOnly", () => {
    const admin = navConfig.find((i) => i.kind === "link" && i.name === "Admin");
    expect(admin).toBeDefined();
    expect((admin as NavLink).adminOnly).toBe(true);
  });

  it("has no other adminOnly slot besides Admin", () => {
    const adminOnlyTop = navConfig.filter(
      (i) => i.kind === "link" && i.adminOnly
    );
    expect(adminOnlyTop.map((i) => (i as NavLink).name)).toEqual(["Admin"]);
  });
});

// ---------------------------------------------------------------------------
// Group membership (children + order + leaf hrefs)
// ---------------------------------------------------------------------------

describe("group membership", () => {
  it("Fulfill = { Workbench, Orders }", () => {
    const fulfill = groupByKey("fulfill");
    expect(fulfill.children.map((c) => c.name)).toEqual(["Workbench", "Orders"]);
    expect(fulfill.children.map((c) => c.href)).toEqual([
      "/workbench",
      "/orders",
    ]);
  });

  it("Stock Ops = { Stocker, Pre-Staging, Journal }", () => {
    const stockOps = groupByKey("stock-ops");
    expect(stockOps.children.map((c) => c.name)).toEqual([
      "Stocker",
      "Pre-Staging",
      "Journal",
    ]);
    expect(stockOps.children.map((c) => c.href)).toEqual([
      "/stocker",
      "/pre-staging",
      "/journal",
    ]);
  });

  it("Catalog = { Products, Price Board } with full 'Price Board' label", () => {
    const catalog = groupByKey("catalog");
    expect(catalog.children.map((c) => c.name)).toEqual([
      "Products",
      "Price Board",
    ]);
    expect(catalog.children.map((c) => c.href)).toEqual([
      "/products",
      "/scratchpad",
    ]);
    const priceBoard = catalog.children.find((c) => c.href === "/scratchpad");
    expect(priceBoard?.label).toBe("Price Board");
  });

  it("every group child is a link-shaped leaf", () => {
    for (const item of navConfig.filter(isGroup)) {
      for (const child of item.children) {
        expect(child.kind).toBe("link");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// flattenNav contract (desktop sidebar)
// ---------------------------------------------------------------------------

describe("flattenNav", () => {
  it("returns a flat list of leaf links (groups expanded to children)", () => {
    const flat = flattenNav(navConfig, true);
    // Every entry is a link leaf.
    expect(flat.every((l) => l.kind === "link")).toBe(true);
    // Order: Fulfill children, Inventory, Stock Ops children, Catalog
    // children, Analytics, Admin.
    expect(flat.map((l) => l.name)).toEqual([
      "Workbench",
      "Orders",
      "Inventory",
      "Stocker",
      "Pre-Staging",
      "Journal",
      "Products",
      "Price Board",
      "Analytics",
      "Admin",
    ]);
  });

  it("flattenNav(config, false) excludes Admin but keeps Orders", () => {
    const names = flattenNav(navConfig, false).map((l) => l.name);
    expect(names).not.toContain("Admin");
    expect(names).toContain("Orders");
  });

  it("flattenNav(config, true) includes Admin", () => {
    const names = flattenNav(navConfig, true).map((l) => l.name);
    expect(names).toContain("Admin");
  });

  it("equals the union of visible leaves (non-admin)", () => {
    // Build the expected union by hand from filterNav so the two helpers agree.
    const visibleTop = filterNav(navConfig, false);
    const expected: string[] = [];
    for (const item of visibleTop) {
      if (item.kind === "link") expected.push(item.name);
      else for (const c of item.children) expected.push(c.name);
    }
    expect(flattenNav(navConfig, false).map((l) => l.name)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// filterNav (shared gating for top-level slots + group children)
// ---------------------------------------------------------------------------

describe("filterNav", () => {
  it("drops the Admin slot when !isAdmin", () => {
    const labels = filterNav(navConfig, false).map((i) => i.label);
    expect(labels).not.toContain("Admin");
    expect(labels).toHaveLength(5);
  });

  it("keeps the Admin slot when isAdmin", () => {
    const labels = filterNav(navConfig, true).map((i) => i.label);
    expect(labels).toContain("Admin");
    expect(labels).toHaveLength(6);
  });

  it("filters adminOnly children within a group (none today, so stable)", () => {
    // Orders is ungated, so Fulfill keeps both children for a non-admin.
    const fulfill = filterNav(navConfig, false).find(
      (i) => i.kind === "group" && i.key === "fulfill"
    ) as NavGroup | undefined;
    expect(fulfill?.children.map((c) => c.name)).toEqual([
      "Workbench",
      "Orders",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Icon collision guard
// ---------------------------------------------------------------------------

describe("icon collisions", () => {
  it("no group icon collides with a direct-link icon", () => {
    const groupIcons = navConfig.filter(isGroup).map((g) => g.icon);
    const directLinkIcons = navConfig.filter(isLink).map((l) => l.icon);
    for (const gi of groupIcons) {
      expect(directLinkIcons).not.toContain(gi);
    }
  });
});
