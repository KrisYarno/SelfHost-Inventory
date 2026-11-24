/**
 * @jest-environment node
 *
 * N0 FR2 F2 (FD1-2) — a provider failure leaves no secret and no address in ANY
 * log line, all the way up the call chain.
 *
 * FR1 E2 sanitised lib/email.ts's own logs, but the OUTER catches (stockChecker's
 * low-stock loop, the weekly report, the test-email route) logged the error OBJECT
 * they caught — whose message (and stack) carried the provider's raw message in
 * full. Here a raw HTTP-client error (config.headers.Authorization, config.data
 * with the recipient, and a long message echoing both past 200 characters) is
 * driven through the REAL EmailService and deliver() — the provider is
 * jest.setup.js's global @sendgrid/mail mock, so nothing can be sent.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: jest.fn() },
    notificationHistory: { findMany: jest.fn(), createMany: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    product: { count: jest.fn(), findMany: jest.fn() },
    product_locations: { aggregate: jest.fn(), groupBy: jest.fn() },
    inventory_logs: { groupBy: jest.fn(), findMany: jest.fn() },
    location: { findMany: jest.fn() },
  },
}));
jest.mock("@/lib/api-utils", () => ({ __esModule: true, apiHandler: (fn: any) => fn }));
jest.mock("@/lib/auth", () => ({ __esModule: true, getSession: jest.fn() }));

import { inspect } from "node:util";
import { NextRequest } from "next/server";
import sgMail from "@sendgrid/mail";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

const send = (sgMail as unknown as { send: jest.Mock }).send;
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const KEY_TEXT = "Bearer SG.fr2-secret-key-value";
const LEAK_TO = "leak.recipient@example.com";
const CRON_SECRET = "n0-fr2-cron-secret";
const OLD_ENV = process.env;

function rawClientError() {
  return Object.assign(
    // A provider/HTTP-client message that echoes the request past 200 characters.
    new Error(`Request failed (${"x".repeat(220)}) echo: to=${LEAK_TO} authorization=${KEY_TEXT}`),
    {
      code: "ECONNRESET",
      config: {
        headers: { Authorization: KEY_TEXT },
        data: JSON.stringify({ personalizations: [{ to: [{ email: LEAK_TO }] }] }),
      },
    }
  );
}

let spies: jest.SpyInstance[] = [];

function everythingLogged(): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: null, showHidden: true })))
    .join("\n");
}

function expectNothingLeaked() {
  const printed = everythingLogged();
  expect(printed).not.toContain("SG.fr2-secret");
  expect(printed).not.toContain("Bearer");
  expect(printed).not.toContain(LEAK_TO);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...OLD_ENV,
    SENDGRID_API_KEY: "SG.test",
    EMAIL_DELIVERY: "on",
    NEXTAUTH_URL: "https://app.example",
    CRON_SECRET,
  };
  delete process.env.TEMPLATE_ID;
  send.mockReset();
  send.mockRejectedValue(rawClientError());
  spies = (["error", "warn", "log"] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  spies.forEach((spy) => spy.mockRestore());
});

afterAll(() => {
  process.env = OLD_ENV;
});

function loadModule<T>(id: string): T {
  let mod: T | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh EmailService reads TEMPLATE_ID per test
    mod = require(id);
  });
  return mod!;
}

it("stockChecker's low-stock loop (inline HTML) logs no secret and no address", async () => {
  db.user.findMany.mockResolvedValue([{ id: 7, email: LEAK_TO, username: "leak", emailAlerts: true }]);
  db.notificationHistory.findMany.mockResolvedValue([]);
  const { StockChecker } = loadModule<typeof import("@/lib/stock-checker")>("@/lib/stock-checker");

  const counts = await new StockChecker().sendLowStockNotifications([
    { id: 1, name: "BPC", currentStock: 1, threshold: 5, daysUntilEmpty: 2 },
  ]);

  expect(send).toHaveBeenCalledTimes(1); // the provider WAS reached (and rejected)
  expect(counts.emailsFailed).toBe(1);
  expectNothingLeaked();
});

it("stockChecker's low-stock loop (dynamic template) logs no secret and no address", async () => {
  process.env.TEMPLATE_ID = "d-template";
  db.user.findMany.mockResolvedValue([{ id: 7, email: LEAK_TO, username: "leak", emailAlerts: true }]);
  db.notificationHistory.findMany.mockResolvedValue([]);
  const { StockChecker } = loadModule<typeof import("@/lib/stock-checker")>("@/lib/stock-checker");

  await new StockChecker().sendLowStockNotifications([
    { id: 1, name: "BPC", currentStock: 1, threshold: 5, daysUntilEmpty: 2 },
  ]);

  expect(send).toHaveBeenCalledTimes(1);
  expectNothingLeaked();
});

it("the weekly report logs no secret and no address", async () => {
  db.systemSetting.findUnique.mockResolvedValue({ key: "weeklyReportsEnabled", value: "true" });
  db.product.count.mockResolvedValue(0);
  db.product_locations.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
  db.product.findMany.mockResolvedValue([]);
  db.inventory_logs.groupBy.mockResolvedValue([]);
  db.product_locations.groupBy.mockResolvedValue([]);
  db.location.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([{ email: LEAK_TO, username: "leak" }]);
  const { GET } = loadModule<typeof import("@/app/api/cron/weekly-report/route")>(
    "@/app/api/cron/weekly-report/route"
  );

  const res = await GET(
    new NextRequest("http://x/api/cron/weekly-report", { headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    {} as never
  );

  expect(send).toHaveBeenCalledTimes(1);
  expect((await res.json()).emailsFailed).toBe(1);
  expectNothingLeaked();
});

it("the test-email route logs no secret and no address", async () => {
  (getSession as jest.Mock).mockResolvedValue({ user: { email: LEAK_TO, name: "Admin", isAdmin: true } });
  const { POST } = loadModule<typeof import("@/app/api/test/email/route")>("@/app/api/test/email/route");

  const res = await POST(new NextRequest("http://x/api/test/email", { method: "POST" }));

  expect(send).toHaveBeenCalledTimes(1);
  expect(res.status).toBe(500);
  expectNothingLeaked();
});

it("the test-email route (dynamic template) logs no secret and no address", async () => {
  process.env.TEMPLATE_ID = "d-template";
  (getSession as jest.Mock).mockResolvedValue({ user: { email: LEAK_TO, name: "Admin", isAdmin: true } });
  const { POST } = loadModule<typeof import("@/app/api/test/email/route")>("@/app/api/test/email/route");

  const res = await POST(new NextRequest("http://x/api/test/email", { method: "POST" }));

  expect(send).toHaveBeenCalledTimes(1);
  expect(res.status).toBe(500);
  expectNothingLeaked();
});

// The OUTER catches log the message ONLY — a string of at most 200 characters,
// never the error object. Driven on the TEMPLATE path, whose wrapper carries the
// provider's message (so a full or object log would show more than 200 chars).
function outerLogArgument(label: string): unknown {
  const errorSpy = spies[0];
  const call = errorSpy.mock.calls.find(([first]) => String(first).startsWith(label));
  expect(call).toBeDefined();
  for (const arg of errorSpy.mock.calls.flat()) expect(arg).not.toBeInstanceOf(Error);
  return call![1];
}

function expectMessageOnly(arg: unknown) {
  expect(typeof arg).toBe("string");
  expect((arg as string).length).toBeLessThanOrEqual(200);
  expect(arg as string).toMatch(/^Failed to send email: Request failed/);
}

it("stockChecker's outer catch logs the message only (a string, at most 200 characters)", async () => {
  process.env.TEMPLATE_ID = "d-template";
  db.user.findMany.mockResolvedValue([{ id: 7, email: LEAK_TO, username: "leak", emailAlerts: true }]);
  db.notificationHistory.findMany.mockResolvedValue([]);
  const { StockChecker } = loadModule<typeof import("@/lib/stock-checker")>("@/lib/stock-checker");
  await new StockChecker().sendLowStockNotifications([
    { id: 1, name: "BPC", currentStock: 1, threshold: 5, daysUntilEmpty: 2 },
  ]);
  expectMessageOnly(outerLogArgument("Failed to send low stock notification"));
});

it("the test-email route's outer catch logs the message only (a string, at most 200 characters)", async () => {
  process.env.TEMPLATE_ID = "d-template";
  (getSession as jest.Mock).mockResolvedValue({ user: { email: LEAK_TO, name: "Admin", isAdmin: true } });
  const { POST } = loadModule<typeof import("@/app/api/test/email/route")>("@/app/api/test/email/route");
  await POST(new NextRequest("http://x/api/test/email", { method: "POST" }));
  expectMessageOnly(outerLogArgument("Test email failed:"));
});

it("the weekly report's outer catch logs the message only (a string, never the object)", async () => {
  db.systemSetting.findUnique.mockResolvedValue({ key: "weeklyReportsEnabled", value: "true" });
  db.product.count.mockResolvedValue(0);
  db.product_locations.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
  db.product.findMany.mockResolvedValue([]);
  db.inventory_logs.groupBy.mockResolvedValue([]);
  db.product_locations.groupBy.mockResolvedValue([]);
  db.location.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([{ email: LEAK_TO, username: "leak" }]);
  const { GET } = loadModule<typeof import("@/app/api/cron/weekly-report/route")>(
    "@/app/api/cron/weekly-report/route"
  );
  await GET(
    new NextRequest("http://x/api/cron/weekly-report", { headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    {} as never
  );
  // sendEmail's own wrapper message is fixed text ("Failed to send email").
  expect(outerLogArgument("Failed to send a weekly report:")).toBe("Failed to send email");
});

it("the error lib/email.ts rethrows carries at most 200 characters of the provider message", async () => {
  process.env.TEMPLATE_ID = "d-template";
  const { EmailService } = loadModule<typeof import("@/lib/email")>("@/lib/email");
  const raw = rawClientError();

  const thrown = await new EmailService()
    .sendLowStockDigest(LEAK_TO, { recipientName: "x", items: [] })
    .then(() => null, (error: Error) => error);

  expect(thrown).toBeInstanceOf(Error);
  expect(thrown!.message).toBe(`Failed to send email: ${raw.message.slice(0, 200)}`);
  expect(thrown!.message).not.toContain(LEAK_TO);
  expect(thrown!.message).not.toContain("SG.fr2-secret");
});
