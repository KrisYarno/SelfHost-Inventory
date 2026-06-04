import { toDayKey, dayKeyStart, nextDayStart, dayKeyRange, saleDayKey } from "@/lib/analytics/dates";

describe("analytics/dates (UTC)", () => {
  test("toDayKey returns the UTC calendar day", () => {
    expect(toDayKey(new Date("2026-06-04T15:30:00.000Z"))).toBe("2026-06-04");
  });
  test("midnight boundary: 23:59:59Z is the same day, 00:00:00Z is the next day", () => {
    expect(toDayKey(new Date("2026-06-04T23:59:59.000Z"))).toBe("2026-06-04");
    expect(toDayKey(new Date("2026-06-05T00:00:00.000Z"))).toBe("2026-06-05");
  });
  test("dayKeyStart / nextDayStart bracket exactly one UTC day", () => {
    expect(dayKeyStart("2026-06-04").toISOString()).toBe("2026-06-04T00:00:00.000Z");
    expect(nextDayStart("2026-06-04").toISOString()).toBe("2026-06-05T00:00:00.000Z");
  });
  test("dayKeyRange is inclusive", () => {
    expect(dayKeyRange("2026-06-03", "2026-06-05")).toEqual(["2026-06-03", "2026-06-04", "2026-06-05"]);
  });
  test("saleDayKey prefers externalCreatedAt, falls back to createdAt", () => {
    expect(saleDayKey({ externalCreatedAt: new Date("2026-01-02T00:00:00Z"), createdAt: new Date("2026-09-09T00:00:00Z") })).toBe("2026-01-02");
    expect(saleDayKey({ externalCreatedAt: null, createdAt: new Date("2026-09-09T12:00:00Z") })).toBe("2026-09-09");
  });
});
