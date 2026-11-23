/**
 * @jest-environment node
 *
 * N0 (RC-6, C2c/C2d, FV-8) — `deliver`, THE one choke point for real email.
 *
 * Runs against jest.setup.js's GLOBAL @sendgrid/mail mock (C2(i)): nothing here
 * can reach the provider. Every env value the switch reads is set explicitly per
 * test, so the repo's .env (which next/jest layers in) cannot steer a result.
 */

import sgMail from "@sendgrid/mail";
import { deliver, EmailService } from "@/lib/email";

const send = (sgMail as unknown as { send: jest.Mock }).send;
const OLD_ENV = process.env;

function setEnv(vars: Record<string, string | undefined>) {
  process.env = { ...OLD_ENV };
  delete process.env.SENDGRID_API_KEY;
  delete process.env.EMAIL_DELIVERY;
  delete process.env.EMAIL_ALLOWLIST;
  delete process.env.TEMPLATE_ID;
  process.env.SENDGRID_FROM_EMAIL = "alerts@advancedresearchpep.com";
  process.env.NEXTAUTH_URL = "https://app.example";
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue([{ statusCode: 202, headers: {} }, {}]);
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

afterAll(() => {
  process.env = OLD_ENV;
});

const MSG = { to: "a@example.com", subject: "S", text: "T", html: "<p>H</p>" };

describe("deliver", () => {
  it("SENDGRID_API_KEY unset => { sent:false, reason:'unconfigured' }, no provider call", async () => {
    setEnv({ EMAIL_DELIVERY: "on" });
    await expect(deliver(MSG)).resolves.toEqual({ sent: false, reason: "unconfigured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("EMAIL_DELIVERY unset (off) => { sent:false, reason:'off' }, no provider call", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test" });
    await expect(deliver(MSG)).resolves.toEqual({ sent: false, reason: "off" });
    expect(send).not.toHaveBeenCalled();
  });

  it("EMAIL_DELIVERY=off => off; a value not understood => off too (fail-closed)", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "off" });
    await expect(deliver(MSG)).resolves.toEqual({ sent: false, reason: "off" });
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "ON" });
    await expect(deliver(MSG)).resolves.toEqual({ sent: false, reason: "off" });
    expect(send).not.toHaveBeenCalled();
  });

  it("allowlist with no allowed address => { sent:false, reason:'not_allowlisted' }", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: "kris@example.com" });
    await expect(deliver({ ...MSG, to: ["x@example.com", "y@example.com"] })).resolves.toEqual({
      sent: false,
      reason: "not_allowlisted",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("a PARTIAL allowlist sends to ONLY the allowed addresses (case-insensitive)", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: "kris@example.com" });
    await expect(
      deliver({ ...MSG, to: ["x@example.com", "Kris@Example.com", "y@example.com"] })
    ).resolves.toEqual({ sent: true, recipients: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const outbound = send.mock.calls[0][0];
    expect(outbound.to).toEqual(["Kris@Example.com"]);
    expect(JSON.stringify(outbound)).not.toContain("x@example.com");
    expect(JSON.stringify(outbound)).not.toContain("y@example.com");
  });

  it("on => sends to every address, with the narrow fields only", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    await expect(deliver({ ...MSG, to: ["a@example.com", "b@example.com"] })).resolves.toEqual({
      sent: true,
      recipients: 2,
    });
    expect(send).toHaveBeenCalledWith({
      to: ["a@example.com", "b@example.com"],
      from: "alerts@advancedresearchpep.com",
      subject: "S",
      text: "T",
      html: "<p>H</p>",
    });
  });

  it("a single-string `to` stays a single string on the wire", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    await deliver(MSG);
    expect(send.mock.calls[0][0].to).toBe("a@example.com");
  });

  it("a provider throw is RETHROWN (callers' catch paths stay)", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    send.mockRejectedValue(new Error("provider 500"));
    await expect(deliver(MSG)).rejects.toThrow("provider 500");
  });

  it.each([
    ["cc", { cc: "hidden@example.com" }],
    ["bcc", { bcc: ["hidden@example.com"] }],
    ["personalizations", { personalizations: [{ to: "hidden@example.com" }] }],
  ])("a message carrying %s is REFUSED (thrown), never sent — even with delivery on", async (_f, extra) => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    await expect(deliver({ ...MSG, ...(extra as object) } as never)).rejects.toThrow(/refused/);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["an object recipient", { email: "a@example.com", name: "A" }],
    ["a number in the list", ["a@example.com", 42]],
    ["null", null],
  ])("%s is REFUSED (thrown), never sent", async (_label, to) => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    await expect(deliver({ ...MSG, to } as never)).rejects.toThrow(/refused/);
    expect(send).not.toHaveBeenCalled();
  });

  it("a message with no recipient address at all is REFUSED (thrown), never sent", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    await expect(deliver({ ...MSG, to: [] })).rejects.toThrow(/refused/);
    await expect(deliver({ ...MSG, to: ["", "  "] })).rejects.toThrow(/refused/);
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FV-8: "every sender goes through deliver", as BEHAVIOUR against the global mock.
// ---------------------------------------------------------------------------

const LOW_STOCK = {
  recipientName: "Kris",
  items: [{ productName: "BPC 5mg", currentStock: 1, threshold: 5, daysUntilEmpty: 2 }],
};
const MINIMUMS = {
  recipientName: "Kris",
  locationItems: [
    { productId: 1, productName: "BPC", locationId: 2, locationName: "Boise", currentQuantity: 1, minQuantity: 4 },
  ],
  combinedItems: [],
};

// Every row has all THREE cells: a shorter row would make jest pass `done` as the
// third test argument.
type Sender = [string, (svc: EmailService, to: string | string[]) => Promise<unknown>, Record<string, string>];
const SENDERS: Sender[] = [
  ["sendEmail", (svc, to) => svc.sendEmail({ to, subject: "S", text: "T", html: "<p>H</p>" }), {}],
  ["sendLowStockDigest (inline HTML)", (svc, to) => svc.sendLowStockDigest(to, LOW_STOCK), {}],
  [
    "sendLowStockDigest (dynamic template)",
    (svc, to) => svc.sendLowStockDigest(to, LOW_STOCK),
    { TEMPLATE_ID: "d-template" },
  ],
  ["sendMinimumsDigest", (svc, to) => svc.sendMinimumsDigest(to, MINIMUMS), {}],
];

describe("FV-8: every sender is gated by the switch", () => {
  it.each(SENDERS)("%s under off: 0 provider calls, returns { sent:false, reason:'off' }", async (_n, run, extra) => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "off", ...extra });
    const result = await run(new EmailService(), ["a@example.com", "b@example.com"]);
    expect(result).toEqual({ sent: false, reason: "off" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(SENDERS)("%s under allowlist: the provider receives exactly the filtered `to`", async (_n, run, extra) => {
    setEnv({
      SENDGRID_API_KEY: "SG.test",
      EMAIL_DELIVERY: "allowlist",
      EMAIL_ALLOWLIST: "b@example.com",
      ...extra,
    });
    const result = await run(new EmailService(), ["a@example.com", "B@example.com"]);
    expect(result).toEqual({ sent: true, recipients: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toEqual(["B@example.com"]);
  });

  it("sendApprovalReminderEmail under off: 0 provider calls, { attempted:false, sent:false }", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "off" });
    const result = await new EmailService().sendApprovalReminderEmail(["admin@example.com"], {
      email: "pending@example.com",
      username: "pending",
    });
    expect(result).toEqual({ attempted: false, sent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("sendApprovalReminderEmail not allowlisted: { attempted:false, sent:false }", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: "kris@example.com" });
    const result = await new EmailService().sendApprovalReminderEmail(["admin@example.com"], {
      email: "pending@example.com",
    });
    expect(result).toEqual({ attempted: false, sent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("sendApprovalReminderEmail under allowlist: the provider receives exactly the filtered `to`", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: "b@example.com" });
    const result = await new EmailService().sendApprovalReminderEmail(["a@example.com", "b@example.com"], {
      email: "pending@example.com",
    });
    expect(result).toEqual({ attempted: true, sent: true });
    expect(send.mock.calls[0][0].to).toEqual(["b@example.com"]);
  });

  it("the low-stock template path no longer logs the recipient address (C2(j))", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on", TEMPLATE_ID: "d-template" });
    await new EmailService().sendLowStockDigest("private.person@example.com", LOW_STOCK);
    const printed = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    expect(printed).not.toContain("private.person@example.com");
  });
});

// ---------------------------------------------------------------------------
// N0 FR1 E2: a send failure never logs the error object. A network-level failure
// rejects with a raw HTTP-client error whose config carries the Authorization
// header (the API key) and the request body (every recipient).
// ---------------------------------------------------------------------------

function everyLoggedArgument(): string {
  const inspect = jest.requireActual("node:util").inspect as typeof import("node:util").inspect;
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : inspect(a, { depth: null, showHidden: true })))
    .join("\n");
}

const LEAK_TO = "leak.person@example.com";

function rawClientError() {
  return Object.assign(new Error("connect ECONNRESET 104.18.0.1:443"), {
    code: "ECONNRESET",
    config: {
      headers: { Authorization: "Bearer SG.secret-key-value" },
      data: JSON.stringify({ personalizations: [{ to: [{ email: LEAK_TO }] }] }),
    },
    request: { _header: "POST /v3/mail/send\r\nAuthorization: Bearer SG.secret-key-value" },
  });
}

describe("E2: send-failure logs carry no secret and no address", () => {
  const RUNS: Array<[string, (svc: EmailService) => Promise<unknown>, Record<string, string>]> = [
    ["sendEmail", (svc) => svc.sendEmail({ to: LEAK_TO, subject: "S", text: "T" }).catch(() => undefined), {}],
    ["sendLowStockDigest (inline)", (svc) => svc.sendLowStockDigest(LEAK_TO, LOW_STOCK).catch(() => undefined), {}],
    [
      "sendLowStockDigest (template)",
      (svc) => svc.sendLowStockDigest(LEAK_TO, LOW_STOCK).catch(() => undefined),
      { TEMPLATE_ID: "d-template" },
    ],
    ["sendMinimumsDigest", (svc) => svc.sendMinimumsDigest(LEAK_TO, MINIMUMS).catch(() => undefined), {}],
    ["sendApprovalReminderEmail", (svc) => svc.sendApprovalReminderEmail([LEAK_TO], { email: LEAK_TO }), {}],
  ];

  it.each(RUNS)("%s: neither the Authorization value nor the address appears in any log argument", async (_n, run, extra) => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on", ...extra });
    send.mockRejectedValue(rawClientError());
    await run(new EmailService());

    expect(errorSpy).toHaveBeenCalled();
    const printed = everyLoggedArgument();
    expect(printed).not.toContain("SG.secret");
    expect(printed).not.toContain("Bearer");
    expect(printed).not.toContain(LEAK_TO);
    // What IS logged: the string code and the message.
    expect(printed).toContain("ECONNRESET");
    // NEVER the error object — not even a sanitized wrapper: every send-failure log
    // argument is the label string or a { code, message, statusCode } summary.
    for (const arg of [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat()) {
      if (typeof arg === "string") continue;
      expect(arg).not.toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(arg)).toBe(Object.prototype);
      for (const key of Object.keys(arg as object)) {
        expect(["code", "message", "statusCode"]).toContain(key);
      }
    }
  });

  // FR1 E2 ruling: SendGrid's ResponseError carries the HTTP status in a NUMERIC
  // `code`, and its `response` is { headers, body } with no statusCode.
  it("a SendGrid ResponseError logs { code: 401, message } and none of its headers or body", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    send.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), {
        code: 401,
        response: {
          headers: { "x-message-id": "hdr-marker-123", authorization: "Bearer SG.secret-key-value" },
          body: { errors: [{ message: `bad ${LEAK_TO}`, field: "personalizations.0.to" }] },
        },
      })
    );
    await new EmailService().sendEmail({ to: LEAK_TO, subject: "S" }).catch(() => undefined);
    expect(errorSpy).toHaveBeenCalledWith("Error sending email:", { code: 401, message: "Unauthorized" });
    const printed = everyLoggedArgument();
    expect(printed).not.toContain(LEAK_TO);
    expect(printed).not.toContain("hdr-marker-123");
    expect(printed).not.toContain("SG.secret");
    expect(printed).not.toContain("personalizations");
  });

  it("a response carrying statusCode also logs it; a non-finite or object code is never logged", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    send.mockRejectedValueOnce(
      Object.assign(new Error("Bad Request"), { code: 400, response: { statusCode: 400, body: { x: LEAK_TO } } })
    );
    await new EmailService().sendEmail({ to: LEAK_TO, subject: "S" }).catch(() => undefined);
    expect(errorSpy).toHaveBeenLastCalledWith("Error sending email:", {
      code: 400,
      message: "Bad Request",
      statusCode: 400,
    });

    for (const code of [Number.NaN, Number.POSITIVE_INFINITY, { status: LEAK_TO }]) {
      send.mockRejectedValueOnce(Object.assign(new Error("odd"), { code }));
      await new EmailService().sendEmail({ to: LEAK_TO, subject: "S" }).catch(() => undefined);
      expect(errorSpy).toHaveBeenLastCalledWith("Error sending email:", { message: "odd" });
    }
    expect(everyLoggedArgument()).not.toContain(LEAK_TO);
  });

  it("the logged message is cut at 200 characters", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on" });
    send.mockRejectedValue(Object.assign(new Error("x".repeat(500)), { code: "E_LONG" }));
    await new EmailService().sendEmail({ to: LEAK_TO, subject: "S" }).catch(() => undefined);
    expect(errorSpy).toHaveBeenCalledWith("Error sending email:", { code: "E_LONG", message: "x".repeat(200) });
  });
});

// ---------------------------------------------------------------------------
// N0 FR1 E10: the template path claims a send ONLY when one happened.
// ---------------------------------------------------------------------------
describe("E10: no 'sending' claim when nothing is sent", () => {
  it("under off: no 'Sending' and no 'email sent' log line", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "off", TEMPLATE_ID: "d-template" });
    await new EmailService().sendLowStockDigest(LEAK_TO, LOW_STOCK);
    const printed = everyLoggedArgument();
    expect(printed).not.toMatch(/sending/i);
    expect(printed).not.toContain("email sent");
  });

  it("when sent: exactly 'email sent (template)', with no address", async () => {
    setEnv({ SENDGRID_API_KEY: "SG.test", EMAIL_DELIVERY: "on", TEMPLATE_ID: "d-template" });
    await new EmailService().sendLowStockDigest(LEAK_TO, LOW_STOCK);
    expect(logSpy).toHaveBeenCalledWith("email sent (template)");
    const printed = everyLoggedArgument();
    expect(printed).not.toMatch(/sending/i);
    expect(printed).not.toContain(LEAK_TO);
  });
});
