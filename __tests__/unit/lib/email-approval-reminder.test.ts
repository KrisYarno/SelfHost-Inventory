/**
 * @jest-environment node
 *
 * Lane 5 S5 — EmailService.sendApprovalReminderEmail discriminated result.
 * The route relies on { attempted, sent } being truthful across the three states.
 */

jest.mock("@sendgrid/mail", () => ({
  __esModule: true,
  default: { setApiKey: jest.fn(), send: jest.fn() },
}));

import sgMail from "@sendgrid/mail";
import { EmailService } from "@/lib/email";

const send = (sgMail as unknown as { send: jest.Mock }).send;
const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  // N0 (C8): the delivery switch is OFF unless set; these pins exercise a stack
  // where delivery is deliberately on.
  process.env = { ...OLD_ENV, EMAIL_DELIVERY: "on" };
});

afterAll(() => {
  process.env = OLD_ENV;
});

const requester = { email: "pending@advancedresearchpep.com", username: "pending" };

describe("sendApprovalReminderEmail", () => {
  it("unconfigured (no API key): { attempted:false, sent:false }, no provider call", async () => {
    delete process.env.SENDGRID_API_KEY;
    const svc = new EmailService();
    const result = await svc.sendApprovalReminderEmail(["admin@x.com"], requester);
    expect(result).toEqual({ attempted: false, sent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("no admin recipients: { attempted:false, sent:false }, no provider call", async () => {
    process.env.SENDGRID_API_KEY = "SG.key";
    const svc = new EmailService();
    const result = await svc.sendApprovalReminderEmail([], requester);
    expect(result).toEqual({ attempted: false, sent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("configured + success: { attempted:true, sent:true }", async () => {
    process.env.SENDGRID_API_KEY = "SG.key";
    send.mockResolvedValue([{ statusCode: 202 }]);
    const svc = new EmailService();
    const result = await svc.sendApprovalReminderEmail(["admin@x.com"], requester);
    expect(result).toEqual({ attempted: true, sent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("configured + provider throw: caught → { attempted:true, sent:false }", async () => {
    process.env.SENDGRID_API_KEY = "SG.key";
    send.mockRejectedValue(new Error("SendGrid 500"));
    const svc = new EmailService();
    const result = await svc.sendApprovalReminderEmail(["admin@x.com"], requester);
    expect(result).toEqual({ attempted: true, sent: false });
  });
});
