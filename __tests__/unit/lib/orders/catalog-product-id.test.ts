/**
 * @jest-environment node
 *
 * THE ONE OWNER OF "IS THIS A STORE CATALOG PRODUCT ID" (hand-typed lines plan,
 * C1 + the S1 source pin).
 *
 * WooCommerce sends `product_id: 0` for a line typed by hand in the store's
 * order screen; a missing id is stored as `""`. One mapping `(Awake, "0")`
 * booked every hand-typed Awake line as one product. `lib/orders/catalog-product-id.ts`
 * is the ONE place that decides such an id is not a store product, and every
 * consumer asks it.
 *
 * TWO KINDS OF PIN:
 *
 *   BEHAVIOUR. The truth table (spaces stripped exactly as MySQL `TRIM()`
 *   strips them; a tab is NOT stripped on either side), the exact user-visible
 *   strings, and the mappings-list label.
 *
 *   SOURCE (S1). A text scan of the eight using files: each one calls the owner
 *   at the named use site, and none carries a second, local spelling of the
 *   rule. Every matcher is proven against an inline fixture that it MUST match,
 *   and against the plausible wrong spelling it must NOT match — a pin proven
 *   only by the tree being clean is a pin nobody knows can fail.
 */

import fs from "node:fs";
import path from "node:path";
import {
  NO_STORE_PRODUCT_IDS,
  NO_STORE_PRODUCT_LINE_HINT,
  NO_STORE_PRODUCT_MAPPING_LABEL,
  NO_STORE_PRODUCT_MAPPING_REFUSAL,
  isCatalogProductId,
  mappingExternalLabel,
  noStoreProductNote,
} from "@/lib/orders/catalog-product-id";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function source(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// C1 — behaviour
// ---------------------------------------------------------------------------

describe("isCatalogProductId — the truth table (binding)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ['""', ""],
    ['" "', " "],
    ['"0"', "0"],
    ['"0 "', "0 "],
    ['" 0"', " 0"],
    ['"  0  "', "  0  "],
  ])("%s is NOT a catalog product", (_label, id) => {
    expect(isCatalogProductId(id)).toBe(false);
  });

  it.each([
    ['"123"', "123"],
    ['"10"', "10"],
    // Woo never emits it, but it is not the string "0".
    ['"00"', "00"],
    // MySQL TRIM() keeps a tab too, so the JS guard and the SQL agree.
    ['"\\t0"', "\t0"],
  ])("%s IS a catalog product", (_label, id) => {
    expect(isCatalogProductId(id)).toBe(true);
  });

  it("the ids it refuses are exactly the two the SQL binds", () => {
    expect([...NO_STORE_PRODUCT_IDS]).toEqual(["", "0"]);
  });
});

describe("the user-visible strings (binding, byte for byte)", () => {
  it("the create refusal", () => {
    expect(NO_STORE_PRODUCT_MAPPING_REFUSAL).toBe(
      "This store line has no store product id (for example, it was typed by hand in the store's order screen), so there is no store product to map.",
    );
  });

  it("the per-line hint", () => {
    expect(NO_STORE_PRODUCT_LINE_HINT).toBe(
      "No store product (for example, typed by hand in the store), so it can't be mapped",
    );
  });

  it("the mappings-list label", () => {
    expect(NO_STORE_PRODUCT_MAPPING_LABEL).toBe(
      "No store product (for example, lines typed by hand in the store)",
    );
  });

  it("the Unmapped note, singular", () => {
    expect(noStoreProductNote(1)).toBe(
      "1 order line has no store product id (for example, it was typed by hand in the store's order screen). It can't be mapped and stays unattributed. Counted across all ages.",
    );
  });

  it("the Unmapped note, plural", () => {
    expect(noStoreProductNote(2)).toBe(
      "2 order lines have no store product id (for example, they were typed by hand in the store's order screen). They can't be mapped and stay unattributed. Counted across all ages.",
    );
    expect(noStoreProductNote(569)).toBe(
      "569 order lines have no store product id (for example, they were typed by hand in the store's order screen). They can't be mapped and stay unattributed. Counted across all ages.",
    );
  });
});

describe("mappingExternalLabel — the mappings list's row AND delete dialog", () => {
  it("a no-store-product mapping is labelled as one, its last line name secondary", () => {
    expect(mappingExternalLabel("0", "BAC 5")).toEqual({
      primary: NO_STORE_PRODUCT_MAPPING_LABEL,
      secondary: "Last line seen: BAC 5",
    });
    // Space-padded spellings are the same mapping to MySQL (PAD SPACE).
    expect(mappingExternalLabel(" 0 ", "BAC 5")).toEqual({
      primary: NO_STORE_PRODUCT_MAPPING_LABEL,
      secondary: "Last line seen: BAC 5",
    });
  });

  it("with no title there is no secondary line, never an empty one", () => {
    expect(mappingExternalLabel("0", null)).toEqual({
      primary: NO_STORE_PRODUCT_MAPPING_LABEL,
      secondary: null,
    });
    expect(mappingExternalLabel("", "")).toEqual({
      primary: NO_STORE_PRODUCT_MAPPING_LABEL,
      secondary: null,
    });
  });

  it("a catalog mapping keeps today's display: the title, else the id", () => {
    expect(mappingExternalLabel("123", "Widget")).toEqual({ primary: "Widget", secondary: null });
    expect(mappingExternalLabel("123", null)).toEqual({ primary: "123", secondary: null });
    expect(mappingExternalLabel("123", "")).toEqual({ primary: "123", secondary: null });
  });
});

// ---------------------------------------------------------------------------
// S1 — the source pin
// ---------------------------------------------------------------------------

const SHARED = "lib/external-orders/shared.ts";
const PRODUCT_LINKS = "lib/validation/product-links.ts";
const BUNDLE_ROUTE = "app/api/products/bundle-links/route.ts";
const UNMAPPED = "lib/reconciliation/unmapped.ts";
const ALERT = "components/workbench/unmapped-items-alert.tsx";
const FULFIL_DIALOG = "components/orders/fulfill-order-dialog.tsx";
const DETAILS_SHEET = "components/orders/external-order-details-sheet.tsx";
const MAPPINGS_PAGE = "app/(app)/admin/product-mappings/page.tsx";

/** The EIGHT using files (seam S1). */
const USING_FILES = [
  SHARED,
  PRODUCT_LINKS,
  BUNDLE_ROUTE,
  UNMAPPED,
  ALERT,
  FULFIL_DIALOG,
  DETAILS_SHEET,
  MAPPINGS_PAGE,
];

/**
 * THE NAMED EXEMPTION. `idOrNull` in the observation feed also treats a
 * trimmed `"0"` as no product, and additionally handles Woo's variation `0` —
 * a different field with its own meaning. It is read-only observation-feed
 * code that builds its own keys from the raw payload, so it is left as it is
 * and kept OUT of the scan below on purpose (plan G1-7), not by oversight.
 */
const EXEMPT = {
  file: "lib/external-orders/fulfillment-observations.ts",
  reason: "observation-feed idOrNull also normalises variation 0; read-only, left untouched (G1-7)",
};

/** Positive use-site matchers, one table row per file (plan §2 S1). */
const USE_SITES: Array<{
  file: string;
  mustMatch: RegExp;
  matchFixture: string;
  nearMiss?: string;
}> = [
  {
    file: SHARED,
    mustMatch: /if \(isCatalogProductId\(lineItem\.externalProductId\)\)/,
    matchFixture: "        if (isCatalogProductId(lineItem.externalProductId)) {",
    nearMiss: "        if (lineItem.externalProductId) {",
  },
  {
    file: PRODUCT_LINKS,
    mustMatch: /\.refine\(isCatalogProductId,/,
    matchFixture: "    .refine(isCatalogProductId, { message: NO_STORE_PRODUCT_MAPPING_REFUSAL }),",
    nearMiss: "    .refine(isCatalogProduct, { message: NO_STORE_PRODUCT_MAPPING_REFUSAL }),",
  },
  {
    file: BUNDLE_ROUTE,
    mustMatch: /if \(!isCatalogProductId\(body\.externalProductId\)\)/,
    matchFixture: "  if (!isCatalogProductId(body.externalProductId)) {",
    // The `!` dropped: the refusal would fire for every catalog id instead.
    nearMiss: "  if (isCatalogProductId(body.externalProductId)) {",
  },
  {
    file: UNMAPPED,
    mustMatch: /TRIM\(i\.externalProductId\) NOT IN \(\$\{Prisma\.join\(NO_STORE_PRODUCT_IDS\)\}\)/,
    matchFixture: "    AND TRIM(i.externalProductId) NOT IN (${Prisma.join(NO_STORE_PRODUCT_IDS)})",
    // No TRIM: a stored " 0" would survive the filter while the JS guard refuses it.
    nearMiss: "    AND i.externalProductId NOT IN (${Prisma.join(NO_STORE_PRODUCT_IDS)})",
  },
  {
    file: UNMAPPED,
    mustMatch: /TRIM\(h\.externalProductId\) IN \(\$\{Prisma\.join\(NO_STORE_PRODUCT_IDS\)\}\)/,
    matchFixture:
      "    WHERE h.isMapped = 0 AND TRIM(h.externalProductId) IN (${Prisma.join(NO_STORE_PRODUCT_IDS)})) AS noStoreProductItems,",
    nearMiss:
      "    WHERE h.isMapped = 0 AND h.externalProductId IN (${Prisma.join(NO_STORE_PRODUCT_IDS)})) AS noStoreProductItems,",
  },
  {
    file: ALERT,
    mustMatch: /isCatalogProductId\(item\.externalProductId\)/,
    matchFixture: "                        isCatalogProductId(item.externalProductId) &&",
  },
  {
    file: FULFIL_DIALOG,
    mustMatch: /isCatalogProductId\(item\.externalProductId\)/,
    matchFixture: "                          {isAdmin && isCatalogProductId(item.externalProductId) && (",
  },
  {
    file: DETAILS_SHEET,
    mustMatch: /isCatalogProductId\(item\.externalProductId\)/,
    matchFixture: "                              {isAdmin && isCatalogProductId(item.externalProductId) && (",
  },
];

/** The alert's OLD truthiness guard — it let `"0"` through as a real reference. */
const ALERT_OLD_GUARD = /item\.externalProductId &&/;
/** The mappings page's OLD display — it showed a `"0"` mapping as a product. */
const PAGE_OLD_DISPLAY = /externalTitle \|\|/;
const PAGE_LABEL_CALL = "mappingExternalLabel(";

/** A second, local spelling of the rule, in either operand order. */
const LOCAL_SPELLINGS = [
  /externalProductId\s*[!=]==?\s*(['"])0?\1/,
  /(['"])0?\1\s*[!=]==?\s*[\w.?]*externalProductId/,
];

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("S1 — the matchers bite (fixtures)", () => {
  it.each(USE_SITES.map((site) => [site.file, site.mustMatch.source, site] as const))(
    "%s: /%s/ matches its fixture and not its near-miss",
    (_file, _source, site) => {
      expect(site.mustMatch.test(site.matchFixture)).toBe(true);
      if (site.nearMiss !== undefined) {
        expect(site.mustMatch.test(site.nearMiss)).toBe(false);
      }
    },
  );

  it("the alert's old-guard matcher matches the old spelling, and not the new one", () => {
    expect(ALERT_OLD_GUARD.test("                        item.externalProductId &&")).toBe(true);
    expect(
      ALERT_OLD_GUARD.test("                        isCatalogProductId(item.externalProductId) &&"),
    ).toBe(false);
  });

  it("the mappings page's matchers match the old display and count the new calls", () => {
    expect(PAGE_OLD_DISPLAY.test("{mapping.externalTitle || mapping.externalProductId}")).toBe(true);
    expect(
      PAGE_OLD_DISPLAY.test("mappingExternalLabel(mapping.externalProductId, mapping.externalTitle)"),
    ).toBe(false);
    expect(
      countOf(
        "mappingExternalLabel(a, b); mappingExternalLabel(c, d); mappingExternalLabel(e, f)",
        PAGE_LABEL_CALL,
      ),
    ).toBe(3);
  });

  it.each([`'0'`, `"0"`, `''`, `""`])(
    "a local spelling against %s is caught in BOTH operand orders",
    (literal) => {
      for (const op of ["===", "!==", "==", "!="]) {
        const forward = `x.externalProductId ${op} ${literal}`;
        const reverse = `${literal} ${op} item?.externalProductId`;
        expect(LOCAL_SPELLINGS.some((re) => re.test(forward))).toBe(true);
        expect(LOCAL_SPELLINGS.some((re) => re.test(reverse))).toBe(true);
      }
    },
  );

  it("a fallback to the empty string is NOT a local spelling of the rule", () => {
    // `shared.ts` stores a missing id as "" exactly this way; it decides nothing.
    expect(LOCAL_SPELLINGS.some((re) => re.test('x.externalProductId || ""'))).toBe(false);
  });
});

describe("S1 — the tree", () => {
  it("the owner exists and imports nothing (safe in client and server bundles)", () => {
    const owner = source("lib/orders/catalog-product-id.ts");
    expect(owner).not.toMatch(/^\s*import\s/m);
    expect(owner).not.toMatch(/\brequire\(/);
  });

  it.each(USING_FILES)("%s imports the owner", (rel) => {
    // Quote style follows each file's own convention.
    expect(source(rel)).toMatch(/from ['"]@\/lib\/orders\/catalog-product-id['"]/);
  });

  it.each(USE_SITES.map((site) => [site.file, site.mustMatch.source, site] as const))(
    "%s calls the owner at its use site: /%s/",
    (rel, _source, site) => {
      expect(site.mustMatch.test(source(rel))).toBe(true);
    },
  );

  it("the unmapped SQL never filters the raw id without TRIM()", () => {
    const src = source(UNMAPPED);
    expect(src).not.toMatch(/AND i\.externalProductId NOT IN/);
    expect(src).not.toMatch(/AND h\.externalProductId IN/);
  });

  it("the alert no longer offers Map on a bare truthiness check", () => {
    expect(ALERT_OLD_GUARD.test(source(ALERT))).toBe(false);
  });

  it("the mappings page renders every external side through the owner", () => {
    const src = source(MAPPINGS_PAGE);
    expect(countOf(src, PAGE_LABEL_CALL)).toBeGreaterThanOrEqual(3);
    expect(PAGE_OLD_DISPLAY.test(src)).toBe(false);
  });

  it.each(USING_FILES)("%s carries no second, local spelling of the rule", (rel) => {
    const src = source(rel);
    const hits = LOCAL_SPELLINGS.filter((re) => re.test(src)).map((re) => re.source);
    expect(hits).toEqual([]);
  });

  it("the assistant's read path did not grow: the bundle-links schema never imports the owner", () => {
    // `lib/validation/bundle-links.ts` is hand-registered on the assistant's
    // scanned read path (toolsuite gate + read-path isolation). The bundle
    // refusal lives in the ROUTE for exactly this reason (plan D3).
    expect(source("lib/validation/bundle-links.ts")).not.toContain("catalog-product-id");
  });

  it("the named exemption is real, and is deliberately not one of the scanned files", () => {
    expect(USING_FILES).not.toContain(EXEMPT.file);
    expect(EXEMPT.reason).toMatch(/G1-7/);
    // If `idOrNull` moves or goes, this exemption is stale and must be revisited.
    expect(source(EXEMPT.file)).toMatch(/function idOrNull\(/);
  });
});
