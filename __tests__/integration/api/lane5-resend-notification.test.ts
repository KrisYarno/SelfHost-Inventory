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
    // N0 (C5, C8): the durable 6 h throttle reads the latest reminder row.
    auditLog: { findFirst: jest.fn() },
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
  auditLog: { findFirst: jest.Mock };
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
  db.auditLog.findFirst.mockResolvedValue(null); // no reminder in the last 6 h
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

// ---------------------------------------------------------------------------
// N0 (C5): one "Notify an administrator" per pending user per 6 hours, read from
// the durable audit trail BEFORE the admins are looked up.
// ---------------------------------------------------------------------------
describe("N0 C5 durable 6 h throttle", () => {
  const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const THROTTLE_TEXT =
    "You already asked within the last 6 hours. An administrator will review your account.";

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    (Date.now as jest.Mock).mockRestore();
  });

  it("reads the latest reminder row for THIS user within 6 h, whatever its delivered value", async () => {
    (emailService.sendApprovalReminderEmail as jest.Mock).mockResolvedValue({
      attempted: true,
      sent: true,
    });
    await POST(req());

    expect(db.auditLog.findFirst).toHaveBeenCalledTimes(1);
    const arg = db.auditLog.findFirst.mock.calls[0][0];
    // Byte-exact where: no `details` / delivered filter, so a failed (delivered:false)
    // reminder counts too and failures cannot be used to flood.
    expect(arg.where).toEqual({
      actionType: "USER_APPROVAL_REMINDER_SENT",
      entityType: "USER",
      entityId: "42",
      createdAt: { gte: new Date(NOW - SIX_HOURS_MS) },
    });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    // The throttle runs BEFORE the admins are looked up.
    expect(db.auditLog.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      db.user.findMany.mock.invocationCallOrder[0]
    );
  });

  it("a second request within 6 h -> 429 with the text + Retry-After; 0 sends, 0 new rows, no admin lookup", async () => {
    db.auditLog.findFirst.mockResolvedValue({ createdAt: new Date(NOW - 60 * 60 * 1000) });

    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: THROTTLE_TEXT });
    // Seconds until the 6 h are up: asked 1 h ago -> 5 h left.
    expect(res.headers.get("Retry-After")).toBe(String(5 * 60 * 60));

    expect(emailService.sendApprovalReminderEmail).not.toHaveBeenCalled();
    expect(recordChange).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it("a previous row with delivered:false still throttles (the row's delivered value is not read)", async () => {
    db.auditLog.findFirst.mockResolvedValue({
      createdAt: new Date(NOW - 5 * 60 * 60 * 1000),
      details: { attempted: true, delivered: false },
    });
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(emailService.sendApprovalReminderEmail).not.toHaveBeenCalled();
    expect(recordChange).not.toHaveBeenCalled();
  });

  it("after 6 h (no row inside the window) -> sends and records as before", async () => {
    db.auditLog.findFirst.mockResolvedValue(null);
    (emailService.sendApprovalReminderEmail as jest.Mock).mockResolvedValue({
      attempted: true,
      sent: true,
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(emailService.sendApprovalReminderEmail).toHaveBeenCalledTimes(1);
    expect(recordChange).toHaveBeenCalledTimes(1);
  });

  it("a soft-deleted requester is refused 403: no throttle read, no send, no record", async () => {
    db.user.findUnique.mockResolvedValue({ ...PENDING_USER, deletedAt: new Date(NOW) });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(db.auditLog.findFirst).not.toHaveBeenCalled();
    expect(emailService.sendApprovalReminderEmail).not.toHaveBeenCalled();
    expect(recordChange).not.toHaveBeenCalled();
  });
});
