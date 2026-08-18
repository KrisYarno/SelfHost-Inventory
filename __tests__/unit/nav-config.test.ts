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
  desktopOnlyNav,
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

  it("Stock Ops = { Stocker, Receiving, Labeling, Journal }", () => {
    const stockOps = groupByKey("stock-ops");
    expect(stockOps.children.map((c) => c.name)).toEqual([
      "Stocker",
      "Receiving",
      "Labeling",
      "Journal",
    ]);
    expect(stockOps.children.map((c) => c.href)).toEqual([
      "/stocker",
      "/receiving",
      "/labeling",
      "/journal",
    ]);
  });

  // The Pre-Staging CHILD is GONE (contract pack C5.3): /receiving is orders +
  // verification and /labeling is the queue that finishes them, so the two sit
  // adjacent as one workflow. `/pre-staging` survives only as a redirect.
  it("Receiving sits adjacent to Labeling inside Stock Ops", () => {
    const names = groupByKey("stock-ops").children.map((c) => c.name);
    const receiving = names.indexOf("Receiving");
    const labeling = names.indexOf("Labeling");
    expect(receiving).toBeGreaterThanOrEqual(0);
    expect(labeling).toBeGreaterThanOrEqual(0);
    expect(Math.abs(receiving - labeling)).toBe(1);
    expect(names).not.toContain("Pre-Staging");
  });

  it("Receiving and Labeling are visible to a non-admin (NOT adminOnly)", () => {
    const stockOps = groupByKey("stock-ops");
    const receiving = stockOps.children.find((c) => c.name === "Receiving");
    const labeling = stockOps.children.find((c) => c.name === "Labeling");
    expect(receiving?.adminOnly).toBeFalsy();
    expect(labeling?.adminOnly).toBeFalsy();
    const flat = flattenNav(navConfig, false).map((l) => l.name);
    expect(flat).toContain("Receiving");
    expect(flat).toContain("Labeling");
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
      "Receiving",
      "Labeling",
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
// Desktop-only nav (Lane 4 R-A3): Assistant is desktop-sidebar-only, the dock
// stays exactly the 6 navConfig slots.
// ---------------------------------------------------------------------------

describe("desktopOnlyNav", () => {
  it("keeps navConfig at EXACTLY 6 slots (Assistant is NOT a dock slot)", () => {
    expect(navConfig).toHaveLength(6);
    const names = flattenNav(navConfig, true).map((l) => l.name);
    expect(names).not.toContain("Assistant");
  });

  it("carries the Assistant leaf pointing at /assistant, ungated", () => {
    expect(desktopOnlyNav.map((l) => l.name)).toEqual(["Assistant"]);
    const assistant = desktopOnlyNav.find((l) => l.name === "Assistant");
    expect(assistant?.href).toBe("/assistant");
    expect(assistant?.kind).toBe("link");
    expect(assistant?.adminOnly).toBeFalsy();
  });

  it("is entirely link-shaped leaves", () => {
    for (const link of desktopOnlyNav) expect(link.kind).toBe("link");
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
