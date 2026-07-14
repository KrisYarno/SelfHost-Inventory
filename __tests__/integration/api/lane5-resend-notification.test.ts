/**
 * @jest-environment node
 *
 * Lane 5 S5 — resend-notification made truthful.
 *   - dispatches an approval reminder to admins, THEN records a change event;
 *   - the event's details.delivered mirrors the real provider outcome;
 *   - the HTTP copy is honest in all three states (delivered / unconfigured /
 *     provider-throw) — it never claims a "sent" it can't stand behind.
 */

jest.mock("@/lib/auth", () => ({ getSession: jest.fn() }));
jest.mock("@/lib/api-utils", () => ({ apiHandler: (fn: any) => fn }));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: (resp: any) => resp,
}));
jest.mock("@/lib/email", () => ({
  emailService: { sendApprovalReminderEmail: jest.fn() },
}));
jest.mock("@/lib/change-tracking", () => ({
  recordChange: jest.fn(async () => undefined),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb({ auditLog: { create: jest.fn() } })),
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { emailService } from "@/lib/email";
import { recordChange } from "@/lib/change-tracking";
import { POST } from "@/app/api/auth/resend-notification/route";

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; findMany: jest.Mock };
};

const PENDING_USER = {
  id: 42,
  email: "pending@advancedresearchpep.com",
  username: "pending.person",
  isApproved: false,
};

function req() {
  return new NextRequest("http://x/api/auth/resend-notification", { method: "POST" });
}

beforeEach(() => {
  jest.clearAllMocks();
  (getSession as jest.Mock).mockResolvedValue({
    user: { id: 42, email: PENDING_USER.email },
  });
  db.user.findUnique.mockResolvedValue(PENDING_USER);
  db.user.findMany.mockResolvedValue([{ email: "admin@advancedresearchpep.com" }]);
});

function recordedEvent() {
  const call = (recordChange as jest.Mock).mock.calls[0];
  return call?.[1];
}

describe("S5 resend-notification", () => {
  it("SendGrid configured: dispatches, records delivered:true, honest copy", async () => {
    (emailService.sendApprovalReminderEmail as jest.Mock).mockResolvedValue({
      attempted: true,
      sent: true,
    });

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe("Administrators will review your account");

    // sent-then-record ordering.
    const sendOrder = (emailService.sendApprovalReminderEmail as jest.Mock).mock
      .invocationCallOrder[0];
    const recordOrder = (recordChange as jest.Mock).mock.invocationCallOrder[0];
    expect(sendOrder).toBeLessThan(recordOrder);

    // dispatched to the admin recipients + requesting user descriptor.
    expect(emailService.sendApprovalReminderEmail).toHaveBeenCalledWith(
      ["admin@advancedresearchpep.com"],
      { email: PENDING_USER.email, username: PENDING_USER.username }
    );

    const event = recordedEvent();
    expect(event.actionType).toBe("USER_APPROVAL_REMINDER_SENT");
    expect(event.entityType).toBe("USER");
    expect(event.entityId).toBe(42);
    expect(event.details.delivered).toBe(true);
    expect(event.details.attempted).toBe(true);
  });

  it("SendGrid unconfigured: skips send, records delivered:false, SAME honest copy", async () => {
    (emailService.sendApprovalReminderEmail as jest.Mock).mockResolvedValue({
      attempted: false,
      sent: false,
    });

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe("Administrators will review your account");

    const event = recordedEvent();
    expect(event.actionType).toBe("USER_APPROVAL_REMINDER_SENT");
    expect(event.details.delivered).toBe(false);
    expect(event.details.attempted).toBe(false);
  });

  it("provider throws (caught by the email helper): records delivered:false, honest copy", async () => {
    (emailService.sendApprovalReminderEmail as jest.Mock).mockResolvedValue({
      attempted: true,
      sent: false,
    });

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe("Administrators will review your account");

    const event = recordedEvent();
    expect(event.details.attempted).toBe(true);
    expect(event.details.delivered).toBe(false);
  });

  it("already-approved user is rejected 400 (no send, no record)", async () => {
    db.user.findUnique.mockResolvedValue({ ...PENDING_USER, isApproved: true });

    const res = await POST(req());
    expect(res.status).toBe(400);
    expect(emailService.sendApprovalReminderEmail).not.toHaveBeenCalled();
    expect(recordChange).not.toHaveBeenCalled();
  });

  it("unauthenticated request is rejected 401", async () => {
    (getSession as jest.Mock).mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
  });
});
