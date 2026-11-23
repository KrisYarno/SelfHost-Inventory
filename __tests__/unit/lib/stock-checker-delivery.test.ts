/**
 * @jest-environment node
 *
 * N0 — the stock-alert email loops tell the truth.
 *   - C1: neither recipient query ever selects a soft-deleted user.
 *   - C3b: NotificationHistory (the 24 h dedupe) is written ONLY for the items
 *     INCLUDED in an email whose deliver returned exactly { sent: true }. A
 *     withheld (suppressed) run writes nothing, so it never silences the next run.
 *   - C3a / D1: runDailyCheck / runMinimumsCheck report emailsSent, emailsNotSent,
 *     emailsFailed (provider throws) and notSentReasons.
 *   - C2(j): no log line carries an address.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    inventory_logs: { findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    notificationHistory: { findMany: jest.fn(), createMany: jest.fn() },
  },
}));

jest.mock("@/lib/email", () => ({
  __esModule: true,
  emailService: { sendLowStockDigest: jest.fn(), sendMinimumsDigest: jest.fn() },
}));

import prisma from "@/lib/prisma";
import { emailService } from "@/lib/email";
import { StockChecker, type LowStockProduct } from "@/lib/stock-checker";

const m = prisma as unknown as {
  product: { findMany: jest.Mock };
  inventory_logs: { findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
  user: { findMany: jest.Mock };
  notificationHistory: { findMany: jest.Mock; createMany: jest.Mock };
};
const lowStockSend = emailService.sendLowStockDigest as jest.Mock;
const minimumsSend = emailService.sendMinimumsDigest as jest.Mock;

const SENT = { sent: true, recipients: 1 };
const OFF = { sent: false, reason: "off" };

const USER_A = {
  id: 11,
  email: "alice.private@example.com",
  username: "alice",
  emailAlerts: true,
  minLocationEmailAlerts: false,
  minCombinedEmailAlerts: false,
  defaultLocationId: 2,
};
const USER_B = { ...USER_A, id: 12, email: "bob.private@example.com", username: "bob" };

const LOW: LowStockProduct[] = [
  { id: 1, name: "BPC 5mg", currentStock: 1, threshold: 5, daysUntilEmpty: 3 },
  { id: 2, name: "TB 10mg", currentStock: 0, threshold: 5, daysUntilEmpty: 0 },
];

const LOC_BREACH = {
  productId: 1,
  productName: "BPC 5mg",
  locationId: 2,
  locationName: "Boise",
  currentQuantity: 1,
  minQuantity: 4,
};
const COMBINED_BREACH = {
  productId: 2,
  productName: "TB 10mg",
  totalQuantity: 0,
  combinedMinimum: 5,
  daysUntilEmpty: 0,
};

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  m.notificationHistory.findMany.mockResolvedValue([]);
  m.notificationHistory.createMany.mockResolvedValue({ count: 0 });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

function everythingLogged(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
    .flat()
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
}

// ---------------------------------------------------------------------------
// C1 — soft-deleted users are never recipients
// ---------------------------------------------------------------------------
describe("C1: the recipient queries exclude soft-deleted users", () => {
  it("low-stock: emailAlerts + approved + NOT deleted (exact where)", async () => {
    m.user.findMany.mockResolvedValue([]);
    await new StockChecker().sendLowStockNotifications(LOW);
    expect(m.user.findMany).toHaveBeenCalledTimes(1);
    expect(m.user.findMany.mock.calls[0][0].where).toEqual({
      emailAlerts: true,
      isApproved: true,
      deletedAt: null,
    });
  });

  it("minimums: approved + NOT deleted + any of the three flags (exact where)", async () => {
    m.user.findMany.mockResolvedValue([]);
    await new StockChecker().sendMinimumNotifications([LOC_BREACH], [COMBINED_BREACH]);
    expect(m.user.findMany).toHaveBeenCalledTimes(1);
    expect(m.user.findMany.mock.calls[0][0].where).toEqual({
      isApproved: true,
      deletedAt: null,
      OR: [{ minLocationEmailAlerts: true }, { minCombinedEmailAlerts: true }, { emailAlerts: true }],
    });
  });
});

// ---------------------------------------------------------------------------
// C3b + D1 — low-stock loop
// ---------------------------------------------------------------------------
describe("low-stock loop: history only for mail actually sent", () => {
  it("a suppressed run (switch off) writes 0 history rows and counts the reason", async () => {
    m.user.findMany.mockResolvedValue([USER_A, USER_B]);
    lowStockSend.mockResolvedValue(OFF);

    const counts = await new StockChecker().sendLowStockNotifications(LOW);

    expect(lowStockSend).toHaveBeenCalledTimes(2);
    expect(m.notificationHistory.createMany).not.toHaveBeenCalled();
    expect(counts).toEqual({
      emailsSent: 0,
      emailsNotSent: 2,
      emailsFailed: 0,
      notSentReasons: { unconfigured: 0, off: 2, not_allowlisted: 0 },
    });
    expect(everythingLogged()).toContain("email not sent (off)");
  });

  it("a sent run writes history as before (every included product, type low_stock)", async () => {
    m.user.findMany.mockResolvedValue([USER_A]);
    lowStockSend.mockResolvedValue(SENT);

    const counts = await new StockChecker().sendLowStockNotifications(LOW);

    expect(m.notificationHistory.createMany).toHaveBeenCalledTimes(1);
    expect(m.notificationHistory.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 11, productId: 1, notificationType: "low_stock" },
        { userId: 11, productId: 2, notificationType: "low_stock" },
      ],
    });
    expect(counts.emailsSent).toBe(1);
    expect(counts.emailsNotSent).toBe(0);
  });

  it("anything other than exactly { sent: true } writes nothing (fail-closed)", async () => {
    m.user.findMany.mockResolvedValue([USER_A]);
    for (const odd of [undefined, {}, { sent: "true" }, { sent: 1 }]) {
      lowStockSend.mockResolvedValueOnce(odd);
      await new StockChecker().sendLowStockNotifications(LOW);
    }
    expect(m.notificationHistory.createMany).not.toHaveBeenCalled();
  });

  it("a provider throw is counted in emailsFailed, writes no history, and the loop goes on", async () => {
    m.user.findMany.mockResolvedValue([USER_A, USER_B]);
    lowStockSend.mockRejectedValueOnce(new Error("provider 500")).mockResolvedValueOnce(SENT);

    const counts = await new StockChecker().sendLowStockNotifications(LOW);

    expect(counts).toEqual({
      emailsSent: 1,
      emailsNotSent: 0,
      emailsFailed: 1,
      notSentReasons: { unconfigured: 0, off: 0, not_allowlisted: 0 },
    });
    expect(m.notificationHistory.createMany).toHaveBeenCalledTimes(1);
    expect(m.notificationHistory.createMany.mock.calls[0][0].data.every((r: any) => r.userId === 12)).toBe(
      true
    );
  });

  it("no log line carries an address (sent, not sent, and failed paths)", async () => {
    m.user.findMany.mockResolvedValue([USER_A, USER_B, { ...USER_A, id: 13, email: "carol.private@example.com" }]);
    lowStockSend
      .mockResolvedValueOnce(SENT)
      .mockResolvedValueOnce(OFF)
      .mockRejectedValueOnce(new Error("provider 500"));

    await new StockChecker().sendLowStockNotifications(LOW);

    const printed = everythingLogged();
    expect(printed).not.toMatch(/alice\.private|bob\.private|carol\.private|@example\.com/);
  });
});

// ---------------------------------------------------------------------------
// C3b + D1 — minimums loop
// ---------------------------------------------------------------------------
describe("minimums loop: history only for the items included in mail actually sent", () => {
  const LOC_USER = { ...USER_A, emailAlerts: false, minLocationEmailAlerts: true };
  const ALL_FLAGS = {
    ...USER_A,
    emailAlerts: true,
    minLocationEmailAlerts: true,
    minCombinedEmailAlerts: true,
  };

  it("a suppressed run (switch off) writes 0 history rows and counts the reason", async () => {
    m.user.findMany.mockResolvedValue([ALL_FLAGS]);
    minimumsSend.mockResolvedValue({ sent: false, reason: "not_allowlisted" });

    const counts = await new StockChecker().sendMinimumNotifications([LOC_BREACH], [COMBINED_BREACH]);

    expect(minimumsSend).toHaveBeenCalledTimes(1);
    expect(m.notificationHistory.createMany).not.toHaveBeenCalled();
    expect(counts).toEqual({
      emailsSent: 0,
      emailsNotSent: 1,
      emailsFailed: 0,
      notSentReasons: { unconfigured: 0, off: 0, not_allowlisted: 1 },
    });
  });

  it("a sent run writes one row per INCLUDED item, as before", async () => {
    m.user.findMany.mockResolvedValue([ALL_FLAGS]);
    minimumsSend.mockResolvedValue(SENT);

    const counts = await new StockChecker().sendMinimumNotifications([LOC_BREACH], [COMBINED_BREACH]);

    expect(m.notificationHistory.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 11, productId: 1, locationId: 2, notificationType: "LOW_STOCK_LOCATION" },
        { userId: 11, productId: 2, locationId: null, notificationType: "LOW_STOCK_COMBINED" },
      ],
    });
    expect(counts.emailsSent).toBe(1);
  });

  it("items LEFT OUT of the email get no row (emailAlerts only: the location breach is not in it)", async () => {
    // emailAlerts alone includes combined items only; the location breach at the
    // user's default location is left out of the email, so it must not be marked seen.
    m.user.findMany.mockResolvedValue([USER_A]);
    minimumsSend.mockResolvedValue(SENT);

    await new StockChecker().sendMinimumNotifications([LOC_BREACH], [COMBINED_BREACH]);

    expect(minimumsSend.mock.calls[0][1].locationItems).toEqual([]);
    expect(m.notificationHistory.createMany).toHaveBeenCalledWith({
      data: [{ userId: 11, productId: 2, locationId: null, notificationType: "LOW_STOCK_COMBINED" }],
    });
  });

  it("a no-attempt branch (flag mismatch) sends nothing and writes nothing", async () => {
    // emailAlerts only, and only a LOCATION breach: no email is attempted.
    m.user.findMany.mockResolvedValue([USER_A]);

    const counts = await new StockChecker().sendMinimumNotifications([LOC_BREACH], []);

    expect(minimumsSend).not.toHaveBeenCalled();
    expect(m.notificationHistory.createMany).not.toHaveBeenCalled();
    expect(counts).toEqual({
      emailsSent: 0,
      emailsNotSent: 0,
      emailsFailed: 0,
      notSentReasons: { unconfigured: 0, off: 0, not_allowlisted: 0 },
    });
  });

  it("anything other than exactly { sent: true } writes nothing (fail-closed)", async () => {
    m.user.findMany.mockResolvedValue([LOC_USER]);
    for (const odd of [undefined, {}, { sent: "yes" }]) {
      minimumsSend.mockResolvedValueOnce(odd);
      await new StockChecker().sendMinimumNotifications([LOC_BREACH], []);
    }
    expect(m.notificationHistory.createMany).not.toHaveBeenCalled();
  });

  it("no log line carries an address", async () => {
    m.user.findMany.mockResolvedValue([ALL_FLAGS, { ...ALL_FLAGS, id: 12, email: "bob.private@example.com" }]);
    minimumsSend.mockResolvedValueOnce(SENT).mockResolvedValueOnce(OFF);
    await new StockChecker().sendMinimumNotifications([LOC_BREACH], [COMBINED_BREACH]);
    expect(everythingLogged()).not.toMatch(/@example\.com/);
  });
});

// ---------------------------------------------------------------------------
// C3a / D1 — the run results
// ---------------------------------------------------------------------------
describe("runDailyCheck / runMinimumsCheck report real counts", () => {
  beforeEach(() => {
    m.systemSetting.findUnique.mockResolvedValue(null); // default threshold
    m.inventory_logs.findMany.mockResolvedValue([]);
    m.product.findMany.mockResolvedValue([
      {
        id: 1,
        name: "BPC 5mg",
        lowStockThreshold: 20,
        deletedAt: null,
        approvalStatus: "APPROVED",
        product_locations: [
          { quantity: 3, minQuantity: 5, locationId: 2, locations: { name: "Boise" } },
        ],
      },
    ]);
  });

  it("runDailyCheck: { lowStockCount, emailsSent, emailsNotSent, emailsFailed, notSentReasons }, no notificationsSent", async () => {
    m.user.findMany.mockResolvedValue([USER_A, USER_B]);
    lowStockSend.mockResolvedValueOnce(OFF).mockResolvedValueOnce(SENT);

    const result = await new StockChecker().runDailyCheck();

    expect(result).toEqual({
      lowStockCount: 1,
      emailsSent: 1,
      emailsNotSent: 1,
      emailsFailed: 0,
      notSentReasons: { unconfigured: 0, off: 1, not_allowlisted: 0 },
    });
    expect(result).not.toHaveProperty("notificationsSent");
  });

  it("runDailyCheck with nothing low: zero counts, no recipient query", async () => {
    m.product.findMany.mockResolvedValue([]);
    const result = await new StockChecker().runDailyCheck();
    expect(result).toEqual({
      lowStockCount: 0,
      emailsSent: 0,
      emailsNotSent: 0,
      emailsFailed: 0,
      notSentReasons: { unconfigured: 0, off: 0, not_allowlisted: 0 },
    });
    expect(m.user.findMany).not.toHaveBeenCalled();
  });

  it("runMinimumsCheck: breach counts plus the email counts", async () => {
    m.user.findMany.mockResolvedValue([{ ...USER_A, minLocationEmailAlerts: true }]);
    minimumsSend.mockResolvedValue({ sent: false, reason: "unconfigured" });

    const result = await new StockChecker().runMinimumsCheck();

    expect(result).toEqual({
      locationBreaches: 1,
      combinedBreaches: 1,
      emailsSent: 0,
      emailsNotSent: 1,
      emailsFailed: 0,
      notSentReasons: { unconfigured: 1, off: 0, not_allowlisted: 0 },
    });
    expect(m.notificationHistory.createMany).not.toHaveBeenCalled();
  });
});
