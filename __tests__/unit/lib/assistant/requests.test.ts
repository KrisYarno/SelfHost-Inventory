/**
 * @jest-environment node
 *
 * Task 1.1 unit contracts for `lib/assistant/requests.ts` (contract pack T3, seam
 * ledger S3): the ONE UTC dayKey source plus the C6 title request writers.
 *
 * Prisma is the GLOBAL jest.setup mock (design D2). G2 (truthful telemetry) is
 * enforced HERE for title rows: usage is written EXACTLY as reported —
 * `undefined` becomes NULL, never 0-as-measurement.
 */

import prisma from "@/lib/prisma";
import {
  finalizeTitleRequest,
  insertTitleRequest,
  utcDayKey,
} from "@/lib/assistant/requests";

/* eslint-disable @typescript-eslint/no-explicit-any */

const db = prisma as unknown as Record<string, any>;

const TITLE_ROW = {
  userId: 42,
  threadId: "cthread0000000000000000001",
  providerKind: "OLLAMA",
  model: "gate-scripted",
  membershipScope: ["c1", "c2"],
};

beforeEach(() => {
  db.assistantRequest.create.mockReset();
  db.assistantRequest.updateMany.mockReset();
  db.assistantRequest.create.mockResolvedValue({ id: 7 });
  db.assistantRequest.updateMany.mockResolvedValue({ count: 1 });
});

describe("utcDayKey (T3): the ONE dayKey source", () => {
  it("returns YYYY-MM-DD", () => {
    expect(utcDayKey(new Date("2026-08-10T13:45:11.000Z"))).toBe("2026-08-10");
  });

  it("does not roll over one millisecond before UTC midnight", () => {
    expect(utcDayKey(new Date("2026-08-10T23:59:59.999Z"))).toBe("2026-08-10");
  });

  it("rolls over exactly AT UTC midnight", () => {
    expect(utcDayKey(new Date("2026-08-11T00:00:00.000Z"))).toBe("2026-08-11");
  });

  it("is UTC, not local: an offset timestamp past LOCAL midnight keeps the UTC day", () => {
    // 00:30 on the 11th in UTC+02:00 is still 22:30 on the 10th in UTC.
    expect(utcDayKey(new Date("2026-08-11T00:30:00.000+02:00"))).toBe("2026-08-10");
    // ...and 23:30 on the 10th in UTC-02:00 is already the 11th in UTC.
    expect(utcDayKey(new Date("2026-08-10T23:30:00.000-02:00"))).toBe("2026-08-11");
  });
});

describe("insertTitleRequest (T3)", () => {
  it("creates a running title row with the membership snapshot and a UTC dayKey", async () => {
    const id = await insertTitleRequest(TITLE_ROW);

    expect(id).toBe(7);
    const data = db.assistantRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      threadId: TITLE_ROW.threadId,
      userId: TITLE_ROW.userId,
      kind: "title",
      status: "running",
      providerKind: "OLLAMA",
      model: "gate-scripted",
      membershipScope: ["c1", "c2"],
    });
    expect(data.dayKey).toBe(utcDayKey(new Date()));
  });

  it("is NOT fenced — it creates the running row, it never conditions on one", async () => {
    await insertTitleRequest(TITLE_ROW);
    expect(db.assistantRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe("finalizeTitleRequest (T3): FENCED on status running", () => {
  it("fences the ok outcome and records durationMs", async () => {
    await finalizeTitleRequest(7, {
      ok: true,
      usage: { inputTokens: 100, outputTokens: 8, totalTokens: 108 },
      durationMs: 950,
    });

    expect(db.assistantRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 7, status: "running" },
      data: {
        status: "ok",
        errorCode: null,
        inputTokens: 100,
        outputTokens: 8,
        totalTokens: 108,
        durationMs: 950,
      },
    });
  });

  it("writes undefined usage fields as NULL, never 0 (G2)", async () => {
    await finalizeTitleRequest(7, {
      ok: true,
      usage: { inputTokens: undefined, outputTokens: 8, totalTokens: undefined },
      durationMs: 12,
    });

    expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
      inputTokens: null,
      outputTokens: 8,
      totalTokens: null,
    });
  });

  it("writes three NULLs when usage never resolved", async () => {
    await finalizeTitleRequest(7, { ok: true, usage: null, durationMs: 12 });

    expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("fences the failed outcome with the masked code AND durationMs", async () => {
    await finalizeTitleRequest(7, { ok: false, errorCode: "PROVIDER_ERROR", durationMs: 10_002 });

    expect(db.assistantRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 7, status: "running" },
      data: { status: "error", errorCode: "PROVIDER_ERROR", durationMs: 10_002 },
    });
  });

  it("never touches a row that is no longer running (0 rows is not an error)", async () => {
    db.assistantRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      finalizeTitleRequest(7, { ok: true, usage: null, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });
});
