/**
 * @jest-environment node
 *
 * N0 — the email-sending ROUTES never claim a send that did not happen.
 *   - D1: /api/admin/stock-check and /api/cron/stock-check nest each run's counts
 *     under `lowStock` / `minimums` (they share field names, so a spread let one
 *     overwrite the other); `lowStockCount` stays top-level for the page.
 *   - C3c / FV-7: the weekly report counts only { sent: true } as sent, reports
 *     emailsNotSent, and logs no address.
 *   - C3 / C4: /api/test/email answers 409 with the reason's true text on any
 *     not-sent result, never a success.
 */

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
  requireAdmin: jest.fn(async () => ({ user: { id: 1, isAdmin: true } })),
  requireCSRF: jest.fn(async () => undefined),
}));
jest.mock("@/lib/rateLimit", () => ({
  __esModule: true,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/stock-checker", () => ({
  __esModule: true,
  stockChecker: { runDailyCheck: jest.fn(), runMinimumsCheck: jest.fn() },
}));
jest.mock("@/lib/email", () => ({
  __esModule: true,
  emailService: {
    generateWeeklyReportHTML: jest.fn(() => "<html></html>"),
    generateWeeklyReportText: jest.fn(() => "text"),
    sendEmail: jest.fn(),
    sendLowStockDigest: jest.fn(),
  },
}));
jest.mock("@/lib/auth", () => ({ __esModule: true, getSession: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    systemSetting: { findUnique: jest.fn() },
    product: { count: jest.fn(), findMany: jest.fn() },
    product_locations: { aggregate: jest.fn(), groupBy: jest.fn() },
    inventory_logs: { groupBy: jest.fn() },
    location: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { stockChecker } from "@/lib/stock-checker";
import { emailService } from "@/lib/email";
import { getSession } from "@/lib/auth";
import { POST as adminStockCheckPOST } from "@/app/api/admin/stock-check/route";
import { GET as cronStockCheckGET } from "@/app/api/cron/stock-check/route";
import { GET as weeklyReportGET } from "@/app/api/cron/weekly-report/route";
import { POST as testEmailPOST } from "@/app/api/test/email/route";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const CRON_SECRET = "n0-test-cron-secret";

const LOW_COUNTS = {
  emailsSent: 0,
  emailsNotSent: 3,
  emailsFailed: 1,
  notSentReasons: { unconfigured: 0, off: 3, not_allowlisted: 0 },
};
const MIN_COUNTS = {
  emailsSent: 2,
  emailsNotSent: 0,
  emailsFailed: 0,
  notSentReasons: { unconfigured: 0, off: 0, not_allowlisted: 0 },
};

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
  (stockChecker.runDailyCheck as jest.Mock).mockResolvedValue({ lowStockCount: 4, ...LOW_COUNTS });
  (stockChecker.runMinimumsCheck as jest.Mock).mockResolvedValue({
    locationBreaches: 5,
    combinedBreaches: 6,
    ...MIN_COUNTS,
  });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

const EXPECTED_STOCK_CHECK_BODY = {
  success: true,
  lowStockCount: 4,
  locationBreaches: 5,
  combinedBreaches: 6,
  lowStock: LOW_COUNTS,
  minimums: MIN_COUNTS,
};

describe("D1: stock-check counts never collide", () => {
  it("admin route nests lowStock / minimums; nothing is spread over anything", async () => {
    const res = await adminStockCheckPOST(
      new NextRequest("http://x/api/admin/stock-check", { method: "POST" })
    );
    const body = await res.json();
    expect(body).toMatchObject(EXPECTED_STOCK_CHECK_BODY);
    // No top-level email count (a spread would have put minimums' over lowStock's).
    for (const key of ["emailsSent", "emailsNotSent", "emailsFailed", "notSentReasons", "notificationsSent"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(Object.keys(body).sort()).toEqual(
      ["combinedBreaches", "duration", "locationBreaches", "lowStock", "lowStockCount", "minimums", "success", "timestamp"].sort()
    );
  });

  it("cron route: the same nested shape", async () => {
    const res = await cronStockCheckGET(
      new NextRequest("http://x/api/cron/stock-check", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      })
    );
    const body = await res.json();
    expect(body).toMatchObject(EXPECTED_STOCK_CHECK_BODY);
    expect(body).not.toHaveProperty("emailsSent");
    expect(body).not.toHaveProperty("notificationsSent");
  });
});

describe("C3c / FV-7: the weekly report counts only mail actually sent", () => {
  beforeEach(() => {
    db.systemSetting.findUnique.mockResolvedValue({ key: "weeklyReportsEnabled", value: "true" });
    db.product.count.mockResolvedValue(0);
    db.product_locations.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    db.product.findMany.mockResolvedValue([]);
    db.inventory_logs.groupBy.mockResolvedValue([]);
    db.product_locations.groupBy.mockResolvedValue([]);
    db.location.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([
      { email: "one.private@example.com", username: "one" },
      { email: "two.private@example.com", username: "two" },
      { email: "three.private@example.com", username: "three" },
      { email: "four.private@example.com", username: "four" },
    ]);
  });

  function cronReq() {
    return new NextRequest("http://x/api/cron/weekly-report", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
  }

  it("emailsSent counts { sent: true } only; emailsNotSent counts { sent: false }; a throw is neither", async () => {
    (emailService.sendEmail as jest.Mock)
      .mockResolvedValueOnce({ sent: true, recipients: 1 })
      .mockResolvedValueOnce({ sent: false, reason: "off" })
      .mockRejectedValueOnce(new Error("provider 500"))
      .mockResolvedValueOnce({ sent: false, reason: "not_allowlisted" });

    const res = await weeklyReportGET(cronReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.emailsSent).toBe(1);
    expect(body.emailsNotSent).toBe(2);
    expect(body.emailsFailed).toBe(1); // N0 FR1 E8

    const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((a) => (a instanceof Error ? a.message : String(a)))
      .join(" ");
    expect(printed).toContain("sent 1 emails, 2 not sent, 1 failed"); // FR1 E8 adds the failed count
    // FV-7: the provider-throw log line is address-free.
    expect(printed).not.toMatch(/@example\.com/);
    expect(errorSpy).toHaveBeenCalledWith("Failed to send a weekly report:", expect.any(Error));
  });

  it("FR1 E8: an all-throw run => emailsFailed equals the recipient count; nothing sent or not-sent", async () => {
    (emailService.sendEmail as jest.Mock).mockRejectedValue(new Error("provider 500"));
    const body = await (await weeklyReportGET(cronReq())).json();
    expect(body.emailsFailed).toBe(4);
    expect(body.emailsSent).toBe(0);
    expect(body.emailsNotSent).toBe(0);
    const printed = logSpy.mock.calls.flat().map(String).join(" ");
    expect(printed).toContain("sent 0 emails, 0 not sent, 4 failed");
  });

  it("a fully suppressed run reports 0 sent, never the recipient count", async () => {
    (emailService.sendEmail as jest.Mock).mockResolvedValue({ sent: false, reason: "off" });
    const body = await (await weeklyReportGET(cronReq())).json();
    expect(body.emailsSent).toBe(0);
    expect(body.emailsNotSent).toBe(4);
  });
});

describe("C3 / C4: the test-email route never claims a send that did not happen", () => {
  beforeEach(() => {
    (getSession as jest.Mock).mockResolvedValue({
      user: { email: "admin@example.com", name: "Admin", isAdmin: true },
    });
  });

  const req = () => new NextRequest("http://x/api/test/email", { method: "POST" });

  it.each([
    ["unconfigured", "SendGrid is not configured on this server."],
    ["off", "Email delivery is off on this server (EMAIL_DELIVERY)."],
    ["not_allowlisted", "Your address is not on this server's email allowlist (EMAIL_ALLOWLIST)."],
  ])("reason %p => 409 { success:false, error: its true text }", async (reason, text) => {
    (emailService.sendLowStockDigest as jest.Mock).mockResolvedValue({ sent: false, reason });
    const res = await testEmailPOST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: text });
  });

  it("a send that went out => 200 success, as before", async () => {
    (emailService.sendLowStockDigest as jest.Mock).mockResolvedValue({ sent: true, recipients: 1 });
    const res = await testEmailPOST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Test email sent successfully");
  });

  it("no delivery result at all is never a success", async () => {
    (emailService.sendLowStockDigest as jest.Mock).mockResolvedValue(undefined);
    const res = await testEmailPOST(req());
    expect(res.status).not.toBe(200);
    expect((await res.json()).success).not.toBe(true);
  });
});
