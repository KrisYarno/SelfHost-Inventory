/**
 * Lane 6 T2 — the pre-send authorization row.
 *
 * THE INVARIANT: no byte leaves this process without a COMMITTED authorization
 * row (codex #13). Therefore `recordAuthorization` THROWS when the DB write
 * rejects, and the chokepoint is required to treat that throw as "do not send".
 *
 * REV-2 #22: an explicit state machine — a nullable `outcome` cannot distinguish
 * "crashed before send" from "crashed after send", which is the single most
 * important question after an incident.
 */

import {
  recordAuthorization,
  markSending,
  finalizeAttempt,
  digestBody,
  ATTEMPT_STATES,
} from "@/lib/platforms/egress/audit";
import prisma from "@/lib/prisma";
import * as changeTracking from "@/lib/change-tracking";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    platformWriteAttempt: {
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordIngestion: jest.fn().mockResolvedValue(true),
}));

const mockPrisma = prisma as unknown as {
  platformWriteAttempt: { create: jest.Mock; update: jest.Mock };
};
const mockRecordIngestion = changeTracking.recordIngestion as jest.Mock;

const baseInput = {
  integrationId: "int_1",
  integrationLabel: "Awake Store",
  platform: "WOOCOMMERCE",
  companyId: "co_1",
  capability: "stock_status" as const,
  method: "POST",
  url: "https://store.example.com/wp-json/wc/v3/products/batch",
  bodyDigest: digestBody({ update: [] }),
  configFingerprint: "a".repeat(64),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.platformWriteAttempt.create.mockResolvedValue({ id: 42 });
  mockPrisma.platformWriteAttempt.update.mockResolvedValue({});
  mockRecordIngestion.mockResolvedValue(true);
});

describe("digestBody", () => {
  it("is a stable sha256 hex digest", () => {
    const d = digestBody({ a: 1 });
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(digestBody({ a: 1 })).toBe(d);
  });

  it("distinguishes different bodies", () => {
    expect(digestBody({ a: 1 })).not.toBe(digestBody({ a: 2 }));
  });

  it("digests an absent body without throwing", () => {
    expect(digestBody(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("recordAuthorization", () => {
  it("returns the row id and persists the decision + state", async () => {
    const { attemptId } = await recordAuthorization({
      ...baseInput,
      decision: "allow",
    });

    expect(attemptId).toBe(42);
    const data = mockPrisma.platformWriteAttempt.create.mock.calls[0][0].data;
    expect(data.decision).toBe("allow");
    // An allowed-but-not-yet-sent row is "authorized" — NOT "sent".
    expect(data.state).toBe("authorized");
    expect(data.capability).toBe("stock_status");
    expect(data.method).toBe("POST");
    expect(data.configFingerprint).toBe("a".repeat(64));
  });

  it("persists a block with its reason and a TERMINAL blocked state", async () => {
    await recordAuthorization({
      ...baseInput,
      decision: "block",
      blockReason: "master_off",
    });

    const data = mockPrisma.platformWriteAttempt.create.mock.calls[0][0].data;
    expect(data.decision).toBe("block");
    expect(data.blockReason).toBe("master_off");
    expect(data.state).toBe("blocked");
  });

  it("persists a dry run as its own terminal state", async () => {
    await recordAuthorization({ ...baseInput, decision: "dry_run" });

    const data = mockPrisma.platformWriteAttempt.create.mock.calls[0][0].data;
    expect(data.decision).toBe("dry_run");
    expect(data.state).toBe("dry_run");
  });

  it("denormalizes integration identity so the record survives deletion (REV-2 #21)", async () => {
    await recordAuthorization({ ...baseInput, decision: "allow" });

    const data = mockPrisma.platformWriteAttempt.create.mock.calls[0][0].data;
    expect(data.integrationLabel).toBe("Awake Store");
    expect(data.platform).toBe("WOOCOMMERCE");
  });

  it("THROWS when the DB write rejects — the caller MUST then block the send", async () => {
    mockPrisma.platformWriteAttempt.create.mockRejectedValue(
      new Error("DB down")
    );

    await expect(
      recordAuthorization({ ...baseInput, decision: "allow" })
    ).rejects.toThrow();
  });

  it("emits a PLATFORM_WRITE_ATTEMPT change event for EVERY decision", async () => {
    for (const decision of ["allow", "block", "dry_run"] as const) {
      jest.clearAllMocks();
      mockPrisma.platformWriteAttempt.create.mockResolvedValue({ id: 7 });

      await recordAuthorization({
        ...baseInput,
        decision,
        blockReason: decision === "block" ? "kill_switch" : undefined,
      });

      expect(mockRecordIngestion).toHaveBeenCalledTimes(1);
      const event = mockRecordIngestion.mock.calls[0][0];
      expect(event.actionType).toBe("PLATFORM_WRITE_ATTEMPT");
    }
  });

  it("does NOT let a failed change event fail the authorization", async () => {
    // The PlatformWriteAttempt row is the hard record; the activity-feed event
    // is best-effort visibility. A feed outage must not block a legitimate write
    // NOR silently drop the hard record.
    mockRecordIngestion.mockRejectedValue(new Error("audit log table gone"));

    await expect(
      recordAuthorization({ ...baseInput, decision: "allow" })
    ).resolves.toEqual({ attemptId: 42 });
  });

  it("never puts the request body (only its digest) into the row", async () => {
    await recordAuthorization({ ...baseInput, decision: "allow" });
    const data = mockPrisma.platformWriteAttempt.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("body");
    expect(data.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("state machine (REV-2 #22)", () => {
  it("exposes the exhaustive state set", () => {
    expect([...ATTEMPT_STATES].sort()).toEqual([
      "authorized",
      "blocked",
      "dry_run",
      "outcome_unknown",
      "response_received",
      "sent",
    ]);
  });

  it("markSending moves authorized -> sent (so a crash after this is distinguishable)", async () => {
    await markSending(42);
    expect(mockPrisma.platformWriteAttempt.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { state: "sent" },
    });
  });

  it("finalizeAttempt records response_received with the http status", async () => {
    await finalizeAttempt(42, "response_received", 200);
    expect(mockPrisma.platformWriteAttempt.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { state: "response_received", httpStatus: 200 },
    });
  });

  it("finalizeAttempt records outcome_unknown when the response was lost", async () => {
    await finalizeAttempt(42, "outcome_unknown");
    expect(mockPrisma.platformWriteAttempt.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { state: "outcome_unknown", httpStatus: undefined },
    });
  });

  it("finalizeAttempt NEVER throws — a post-flight bookkeeping failure must not mask the result", async () => {
    mockPrisma.platformWriteAttempt.update.mockRejectedValue(
      new Error("DB down")
    );
    await expect(
      finalizeAttempt(42, "response_received", 200)
    ).resolves.toBeUndefined();
  });

  it("markSending NEVER throws either", async () => {
    mockPrisma.platformWriteAttempt.update.mockRejectedValue(
      new Error("DB down")
    );
    await expect(markSending(42)).resolves.toBeUndefined();
  });
});
