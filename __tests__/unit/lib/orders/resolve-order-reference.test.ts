// @jest-environment node
//
// REFERENCE-RESOLUTION ROUND — the free-text order reference, resolved
// server-side.
//
// The sibling resolver (resolve-selected-order.ts) answers a different
// question with a different consequence, and the difference is the whole
// design:
//
//   selectedExternalOrderId  a CLIENT-SUPPLIED ID annotating a stock write.
//                            Unverifiable => the PAYLOAD is invalid => 400.
//   orderReference           free text a packer typed. Unresolvable => the
//                            DEDUCTION IS STILL LEGAL; only the ATTRIBUTION is
//                            withheld. It has always been legal, it is what
//                            production has been doing for months, and failing
//                            it now would break packing to gain a column.
//
// So nothing in this module throws for a reference it cannot use. It returns a
// NAMED outcome, and the caller stamps or does not.
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireCompanyMembership: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));

import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import prisma from "@/lib/prisma";
import { requireCompanyMembership } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import {
  ORDER_ATTRIBUTION_SOURCE,
  ORDER_REFERENCE_CANDIDATE_CAP,
  ORDER_REFERENCE_SHAPE,
  isReferenceResolutionEligible,
  normalizeOrderReference,
  resolveOrderReference,
} from "@/lib/orders/resolve-order-reference";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const ORDER_A = "cmdq7f3k80001s6h4p2n9wxyz";
const ORDER_B = "cmdq7f3k80099s6h4p2n9zzzz";
const COMPANY_ID = "company-abc";
const USER = { id: 7, isAdmin: false };

const candidate = (id: string, orderNumber: string, companyId = COMPANY_ID) => ({
  id,
  orderNumber,
  companyId,
});

beforeEach(() => {
  jest.clearAllMocks();
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
});

describe("the shape bar — conservative, and derived from the data", () => {
  it.each(["12345", "1", "0007", "12345678901234567890"])("accepts the digit string %p", (raw) => {
    expect(normalizeOrderReference(raw)).toBe(raw);
  });

  it.each([
    ["free text", "walk-in 88"],
    ["a prefix", "#12345"],
    ["a shop prefix", "WC-123"],
    ["an inner space", "12 345"],
    ["letters", "abc"],
    ["empty", ""],
    ["whitespace", "   "],
    ["21 digits", "1".repeat(21)],
    ["absent", undefined],
    ["null", null],
  ])("refuses %s", (_label, raw) => {
    expect(normalizeOrderReference(raw as string)).toBeNull();
  });

  it("trims, and only trims", () => {
    expect(normalizeOrderReference("  12345\n")).toBe("12345");
    expect(ORDER_REFERENCE_SHAPE.test("12345")).toBe(true);
  });

  it("never reaches the database for a reference it cannot use", async () => {
    await expect(resolveOrderReference("walk-in 88", USER)).resolves.toEqual({
      outcome: "unusable",
      orderRecordId: null,
    });
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });
});

describe("the eligibility predicate — an absent chip is not a stated `other`", () => {
  it("resolves for an ABSENT intent (the free-text flow renders no chip at all)", () => {
    expect(isReferenceResolutionEligible(undefined)).toBe(true);
    expect(isReferenceResolutionEligible(null)).toBe(true);
  });

  it("resolves for an explicit `order`", () => {
    expect(isReferenceResolutionEligible("order")).toBe(true);
  });

  it("REFUSES for every explicit non-order value", () => {
    expect(isReferenceResolutionEligible("other")).toBe(false);
    expect(isReferenceResolutionEligible("damage-loss")).toBe(false);
  });
});

describe("the exact-unique bar", () => {
  it("resolves a single exact match and proves membership against ITS company", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, "12345")] as any);

    await expect(resolveOrderReference("12345", USER)).resolves.toEqual({
      outcome: "resolved",
      orderRecordId: ORDER_A,
    });

    expect(db.externalOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderNumber: "12345" },
        take: ORDER_REFERENCE_CANDIDATE_CAP,
      })
    );
    // The ONE membership predicate, on the RESOLVED order's company.
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
  });

  it("returns `unmatched` when nothing comes back", async () => {
    db.externalOrder.findMany.mockResolvedValue([] as any);

    await expect(resolveOrderReference("12345", USER)).resolves.toEqual({
      outcome: "unmatched",
      orderRecordId: null,
    });
    expect(requireCompanyMembership).not.toHaveBeenCalled();
  });

  it("returns `ambiguous` when two orders share the number", async () => {
    db.externalOrder.findMany.mockResolvedValue([
      candidate(ORDER_A, "12345"),
      candidate(ORDER_B, "12345", "company-other"),
    ] as any);

    await expect(resolveOrderReference("12345", USER)).resolves.toEqual({
      outcome: "ambiguous",
      orderRecordId: null,
    });
    expect(requireCompanyMembership).not.toHaveBeenCalled();
  });

  it("filters collation-equal candidates out before counting", async () => {
    // MySQL's default collation is case- and pad-insensitive, so the WHERE is a
    // CANDIDATE fetch and uniqueness is decided in JS, on bytes. Here the only
    // candidate is not an exact match, so the reference matched nothing.
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, "12345 ")] as any);

    await expect(resolveOrderReference("12345", USER)).resolves.toMatchObject({
      outcome: "unmatched",
    });
  });

  it("treats a full candidate page as ambiguous rather than claiming uniqueness", async () => {
    db.externalOrder.findMany.mockResolvedValue(
      Array.from({ length: ORDER_REFERENCE_CANDIDATE_CAP }, (_, i) =>
        candidate(`cm0order${i}`, i === 0 ? "12345" : "12345 ")
      ) as any
    );

    await expect(resolveOrderReference("12345", USER)).resolves.toMatchObject({
      outcome: "ambiguous",
    });
  });
});

describe("membership withholds the attribution — it never rejects the deduction", () => {
  it("returns `not-a-member` instead of throwing the sibling resolver's 400", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, "12345", "company-other")] as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    await expect(resolveOrderReference("12345", USER)).resolves.toEqual({
      outcome: "not-a-member",
      orderRecordId: null,
    });
  });

  it("passes the caller's admin flag through rather than deciding admin-ness", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, "12345")] as any);

    await resolveOrderReference("12345", { id: 9, isAdmin: true });

    expect(requireCompanyMembership).toHaveBeenCalledWith(9, COMPANY_ID, true);
  });

  it("lets a non-AppError fault propagate untouched (a DB outage is not a bad reference)", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, "12345")] as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(new TypeError("connection lost"));

    await expect(resolveOrderReference("12345", USER)).rejects.toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// THE OPT-IN CALLER SCOPE (reconciliation Part 2, pack § P2-B3-1R, R-a.5)
//
// With `scope: 'caller'`, a NON-admin's candidates are read inside their own
// companies — the same `resolveCallerCompanyIds(user, null)` read the order
// search makes — so the save agrees with the member-scoped preview. The
// default (`'global'`) is today's behaviour, pinned by every suite above.
//
// The candidate read is driven by a small fake that APPLIES the `where`
// (number and company), so "the database only answered inside the scope" is
// what the fixture does, not what the test assumes.
// ---------------------------------------------------------------------------

describe("scope: 'caller' — a member resolves within their own companies", () => {
  const OWN = COMPANY_ID;
  const FOREIGN = "company-other";

  /** The book of orders the fake reads from. */
  function book(rows: Array<{ id: string; orderNumber: string; companyId: string }>): void {
    db.externalOrder.findMany.mockImplementation((async (args: {
      where: { orderNumber: string; companyId?: { in: string[] } };
      take: number;
    }) =>
      rows
        .filter((r) => r.orderNumber === args.where.orderNumber)
        .filter((r) => args.where.companyId === undefined || args.where.companyId.in.includes(r.companyId))
        .slice(0, args.take)) as any);
  }

  function memberOf(companyIds: string[]): void {
    db.userCompany.findMany.mockResolvedValue(companyIds.map((companyId) => ({ companyId })) as any);
  }

  it("a number held ONLY by another company -> unmatched (was not-a-member globally)", async () => {
    book([candidate(ORDER_B, "12345", FOREIGN)]);
    memberOf([OWN]);

    await expect(resolveOrderReference("12345", USER, { scope: "caller" })).resolves.toEqual({
      outcome: "unmatched",
      orderRecordId: null,
    });
    expect(db.userCompany.findMany).toHaveBeenCalledTimes(1);
    expect(db.userCompany.findMany).toHaveBeenCalledWith({
      where: { userId: 7 },
      select: { companyId: true },
    });
    expect(db.externalOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderNumber: "12345", companyId: { in: [OWN] } },
        take: ORDER_REFERENCE_CANDIDATE_CAP,
      })
    );
    // Nothing to probe: the scoped read found no candidate.
    expect(requireCompanyMembership).not.toHaveBeenCalled();
  });

  it("a number held by their company AND another -> resolves to their own (was ambiguous globally)", async () => {
    book([candidate(ORDER_A, "12345", OWN), candidate(ORDER_B, "12345", FOREIGN)]);
    memberOf([OWN]);

    await expect(resolveOrderReference("12345", USER, { scope: "caller" })).resolves.toEqual({
      outcome: "resolved",
      orderRecordId: ORDER_A,
    });
    // The membership belt still runs, on the resolved order's company.
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, OWN, false);

    // The same book read globally is the ambiguity it always was.
    jest.clearAllMocks();
    await expect(resolveOrderReference("12345", USER)).resolves.toMatchObject({
      outcome: "ambiguous",
    });
  });

  it("two of their OWN companies' orders share the number -> still ambiguous", async () => {
    book([candidate(ORDER_A, "12345", OWN), candidate(ORDER_B, "12345", "company-two")]);
    memberOf([OWN, "company-two"]);

    await expect(resolveOrderReference("12345", USER, { scope: "caller" })).resolves.toEqual({
      outcome: "ambiguous",
      orderRecordId: null,
    });
  });

  it("an ADMIN is never scoped: no companyId key, and no membership read", async () => {
    book([candidate(ORDER_B, "12345", FOREIGN)]);

    await expect(
      resolveOrderReference("12345", { id: 9, isAdmin: true }, { scope: "caller" })
    ).resolves.toEqual({ outcome: "resolved", orderRecordId: ORDER_B });

    const where = (db.externalOrder.findMany.mock.calls[0][0] as { where: object }).where;
    expect(where).toEqual({ orderNumber: "12345" });
    expect("companyId" in where).toBe(false);
    expect(db.userCompany.findMany).not.toHaveBeenCalled();
    expect(requireCompanyMembership).toHaveBeenCalledWith(9, FOREIGN, true);
  });

  it("a member of ZERO companies -> unmatched (scoped to nothing, never unscoped)", async () => {
    book([candidate(ORDER_A, "12345", OWN)]);
    memberOf([]);

    await expect(resolveOrderReference("12345", USER, { scope: "caller" })).resolves.toEqual({
      outcome: "unmatched",
      orderRecordId: null,
    });
    expect(db.externalOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderNumber: "12345", companyId: { in: [] } } })
    );
  });

  it("a throw from the scope read PROPAGATES (the route records resolver-error), and nothing is read after it", async () => {
    db.userCompany.findMany.mockRejectedValue(new Error("connection lost"));

    await expect(resolveOrderReference("12345", USER, { scope: "caller" })).rejects.toThrow(
      "connection lost"
    );
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });

  it("an unusable reference never reaches the database — not even the scope read", async () => {
    await expect(resolveOrderReference("walk-in 88", USER, { scope: "caller" })).resolves.toEqual({
      outcome: "unusable",
      orderRecordId: null,
    });
    expect(db.userCompany.findMany).not.toHaveBeenCalled();
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });

  // The race arm (R-a.5 keeps `not-a-member` reachable for a member): the scope
  // read still listed the company, and membership was removed before the belt.
  it("membership removed between the scope read and the belt -> not-a-member", async () => {
    book([candidate(ORDER_A, "12345", OWN)]);
    memberOf([OWN]);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    await expect(resolveOrderReference("12345", USER, { scope: "caller" })).resolves.toEqual({
      outcome: "not-a-member",
      orderRecordId: null,
    });
  });

  it("the default and an explicit 'global' are today's read: no companyId key, no membership read", async () => {
    for (const opts of [undefined, {}, { scope: "global" as const }]) {
      jest.clearAllMocks();
      (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
      book([candidate(ORDER_B, "12345", FOREIGN)]);

      await expect(resolveOrderReference("12345", USER, opts)).resolves.toEqual({
        outcome: "resolved",
        orderRecordId: ORDER_B,
      });
      expect((db.externalOrder.findMany.mock.calls[0][0] as { where: object }).where).toEqual({
        orderNumber: "12345",
      });
      expect(db.userCompany.findMany).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// The duplicated rule, pinned as one rule
// ---------------------------------------------------------------------------

describe("SEAM — the live slice and the companion backfill apply the SAME rules", () => {
  // The backfill is a standalone CJS script that imports @prisma/client, its own
  // planner and NOTHING else (no lib/, no next/). It therefore cannot import
  // this module, and the shape rule + the source vocabulary exist twice. That
  // duplication is forced; drift between the two copies is not, so it is pinned.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const plan = require("../../../../scripts/backfill/order-attribution/plan");

  it("uses the identical order-reference shape", () => {
    expect(plan.ORDER_REFERENCE_SHAPE.source).toBe(ORDER_REFERENCE_SHAPE.source);
    expect(plan.ORDER_REFERENCE_SHAPE.flags).toBe(ORDER_REFERENCE_SHAPE.flags);
  });

  it("classifies the same references the same way", () => {
    for (const raw of ["12345", " 12345 ", "walk-in 88", "#12345", "", "abc", "1".repeat(21)]) {
      expect(plan.isUsableOrderReference(raw, "STRING")).toBe(normalizeOrderReference(raw) !== null);
    }
  });

  it("names the two evidence sources identically", () => {
    expect(ORDER_ATTRIBUTION_SOURCE.SELECTED).toBe(plan.ATTRIBUTION_SOURCE.SELECTED);
    expect(ORDER_ATTRIBUTION_SOURCE.REFERENCE_RESOLVED).toBe(plan.ATTRIBUTION_SOURCE.REFERENCE_RESOLVED);
  });
});
