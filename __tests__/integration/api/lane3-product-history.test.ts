// @jest-environment node
//
// Lane 3 Task 3 (Lane W2-A) — GET /api/products/[id]/history route contract.
// The route is a thin validate-and-delegate shell over lib/history/union-timeline
// (getProductTimeline is mocked here; its merge/pagination correctness is proven
// in the trunk union-timeline suite). This suite pins: requireApproved guard,
// product-existence 404, limit 1-100 validation, base64url(JSON TimelineCursor)
// decode -> 400 on garbage, and correct caller/cursor delegation + passthrough.

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));

jest.mock("@/lib/history/union-timeline", () => ({
  __esModule: true,
  getProductTimeline: jest.fn(),
}));

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { product: { findUnique: jest.fn() } },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/products/[id]/history/route";
import { requireApproved } from "@/lib/api-utils";
import { getProductTimeline, type TimelineCursor } from "@/lib/history/union-timeline";
import prisma from "@/lib/prisma";

const db = prisma as unknown as { product: { findUnique: jest.Mock } };
const timelineMock = getProductTimeline as jest.Mock;
const ctx = (id: string) => ({ params: { id } });

const RESULT = {
  entries: [],
  nextCursor: null as TimelineCursor | null,
  dataStart: { events: null, ledger: null },
};

function encodeCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function req(path: string) {
  return new NextRequest(`http://t/api/products/5/history${path}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, isAdmin: false, isApproved: true },
  });
  db.product.findUnique.mockResolvedValue({ id: 5 });
  timelineMock.mockResolvedValue(RESULT);
});

describe("guard + existence", () => {
  it("calls requireApproved before any data access", async () => {
    await GET(req(""), ctx("5"));
    expect(requireApproved).toHaveBeenCalled();
  });

  it("invalid (non-numeric) id => 400, no timeline call", async () => {
    const res = await GET(req(""), ctx("abc"));
    expect(res.status).toBe(400);
    expect(timelineMock).not.toHaveBeenCalled();
    expect(db.product.findUnique).not.toHaveBeenCalled();
  });

  it("unknown product => 404, timeline never called", async () => {
    db.product.findUnique.mockResolvedValue(null);
    const res = await GET(req(""), ctx("5"));
    expect(res.status).toBe(404);
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it("known product => 200 and returns { entries, nextCursor, dataStart } verbatim", async () => {
    const payload = {
      entries: [{ kind: "ledger", ts: "2026-07-01T00:00:00.000Z", ledgerRows: [], orphanKind: "legacy-unlinked" }],
      nextCursor: { ts: "2026-07-01T00:00:00.000Z", lastEventId: 10, lastLedgerId: 20 },
      dataStart: { events: "2026-06-01T00:00:00.000Z", ledger: "2026-05-01T00:00:00.000Z" },
    };
    timelineMock.mockResolvedValue(payload);
    const res = await GET(req(""), ctx("5"));
    expect(res.status).toBe(200);
    const body = await (res as Response).json();
    expect(body).toEqual(payload);
  });
});

describe("delegation", () => {
  it("passes caller { userId, isAdmin } through from the session", async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 99, isAdmin: true } });
    await GET(req(""), ctx("5"));
    expect(timelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 5, caller: { userId: 99, isAdmin: true } }),
    );
  });

  it("no query params => limit/before undefined (contract default in the lib)", async () => {
    await GET(req(""), ctx("5"));
    const arg = timelineMock.mock.calls[0][0];
    expect(arg.limit).toBeUndefined();
    expect(arg.before).toBeUndefined();
  });
});

describe("limit validation", () => {
  it("passes a valid limit through", async () => {
    await GET(req("?limit=25"), ctx("5"));
    expect(timelineMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it.each(["0", "101", "-5", "abc", "3.5"])("rejects out-of-range/garbage limit=%s => 400", async (v) => {
    const res = await GET(req(`?limit=${v}`), ctx("5"));
    expect(res.status).toBe(400);
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it("accepts the boundary limits 1 and 100", async () => {
    await GET(req("?limit=1"), ctx("5"));
    await GET(req("?limit=100"), ctx("5"));
    expect(timelineMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 1 }));
    expect(timelineMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 100 }));
  });
});

describe("cursor (before) validation + decode", () => {
  it("decodes a valid base64url(JSON TimelineCursor) and passes it through", async () => {
    const cursor: TimelineCursor = {
      ts: "2026-07-01T12:00:00.000Z",
      lastEventId: 42,
      lastLedgerId: 84,
    };
    await GET(req(`?before=${encodeCursor(cursor)}`), ctx("5"));
    expect(timelineMock).toHaveBeenCalledWith(expect.objectContaining({ before: cursor }));
  });

  it("rejects non-base64/non-JSON garbage => 400, no timeline call", async () => {
    const res = await GET(req("?before=@@not-a-cursor@@"), ctx("5"));
    expect(res.status).toBe(400);
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it("rejects a well-formed base64 blob whose JSON is the wrong shape => 400", async () => {
    const bad = Buffer.from(JSON.stringify({ nope: true })).toString("base64url");
    const res = await GET(req(`?before=${bad}`), ctx("5"));
    expect(res.status).toBe(400);
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it("rejects a cursor whose ts is not a parseable date => 400", async () => {
    const bad = Buffer.from(
      JSON.stringify({ ts: "not-a-date", lastEventId: 1, lastLedgerId: 1 }),
    ).toString("base64url");
    const res = await GET(req(`?before=${bad}`), ctx("5"));
    expect(res.status).toBe(400);
    expect(timelineMock).not.toHaveBeenCalled();
  });
});
