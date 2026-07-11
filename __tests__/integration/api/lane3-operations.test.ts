// @jest-environment node
// Lane 3 (Task 5, W2-C): GET /api/analytics/operations — requireApproved, GLOBAL
// (no company param), one aggregate payload for the Operations view.

jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/analytics/queries", () => ({
  getOperationsRows: jest.fn(),
  getShrinkageSummary: jest.fn(),
  getValuationSummary: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/operations/route";
import { requireApproved } from "@/lib/api-utils";
import {
  getOperationsRows,
  getShrinkageSummary,
  getValuationSummary,
} from "@/lib/analytics/queries";

const getOperationsRowsMock = getOperationsRows as jest.Mock;
const getShrinkageSummaryMock = getShrinkageSummary as jest.Mock;
const getValuationSummaryMock = getValuationSummary as jest.Mock;

const req = (qs = "") => new NextRequest(`http://x/api/analytics/operations${qs}`);

function seedHappyPath() {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  getOperationsRowsMock.mockResolvedValue({
    rows: [{ productId: 1, name: "Widget", currentStock: 5, attention: "ok" }],
    dataStarts: { sale: null, adjustment: null, receipt: null, snapshot: null },
  });
  getShrinkageSummaryMock.mockResolvedValue({
    byReason: {
      DAMAGE: { units: 0, valueAtCurrentCostCents: 0 },
      THEFT: { units: 0, valueAtCurrentCostCents: 0 },
      EXPIRY: { units: 0, valueAtCurrentCostCents: 0 },
      COUNT: { units: 0, valueAtCurrentCostCents: 0 },
      CORRECTION: { units: 0, valueAtCurrentCostCents: 0 },
      UNCLASSIFIED: { units: 0, valueAtCurrentCostCents: 0 },
    },
    dataStart: null,
  });
  getValuationSummaryMock.mockResolvedValue({
    atCurrentCostCents: 3500,
    atReceiptCostCents: null,
    receiptCoverage: { have: 0, of: 1 },
  });
}

beforeEach(() => jest.clearAllMocks());

test("returns the aggregate Operations payload (rows + dataStarts + shrinkage + valuation)", async () => {
  seedHappyPath();
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.scope).toBe("global");
  expect(body.windowDays).toBe(90); // default
  expect(body.rows).toHaveLength(1);
  expect(body.dataStarts).toEqual({ sale: null, adjustment: null, receipt: null, snapshot: null });
  expect(body.shrinkage90.byReason.DAMAGE).toBeDefined();
  expect(body.valuation.atCurrentCostCents).toBe(3500);
});

test("requireApproved gates the route", async () => {
  seedHappyPath();
  await GET(req());
  expect(requireApproved).toHaveBeenCalledTimes(1);
});

test("is GLOBAL: no company param is ever read or forwarded to the queries", async () => {
  seedHappyPath();
  await GET(req("?companyId=c1"));
  // windowDays default; companyId is ignored — getOperationsRows never receives it.
  expect(getOperationsRowsMock).toHaveBeenCalledWith({ windowDays: 90 });
  const arg = getOperationsRowsMock.mock.calls[0][0];
  expect(arg).not.toHaveProperty("companyId");
});

test("windowDays=30 flows to getOperationsRows", async () => {
  seedHappyPath();
  await GET(req("?windowDays=30"));
  expect(getOperationsRowsMock).toHaveBeenCalledWith({ windowDays: 30 });
});

test("garbage windowDays => 400 (never a silent default)", async () => {
  seedHappyPath();
  const res = await GET(req("?windowDays=45"));
  expect(res.status).toBe(400);
  expect(getOperationsRowsMock).not.toHaveBeenCalled();
});
