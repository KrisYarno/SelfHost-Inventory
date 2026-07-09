import {
  DAY_TZ,
  formatDayKey,
  parseDayKey,
  startOfDayUTC,
  endOfDayUTC,
  addDays,
  eachDayUTC,
  parseDayParam,
  parseReportDateRange,
} from "@/lib/reports/date-range";

// These assertions are all in explicit UTC, so they hold regardless of the test
// host's timezone (the helpers are toISOString()/Date.UTC-based, not date-fns-local).

describe("reports/date-range day helpers (UTC)", () => {
  test("DAY_TZ is the single UTC seam", () => {
    expect(DAY_TZ).toBe("UTC");
  });

  test("formatDayKey returns the UTC calendar day of an instant", () => {
    expect(formatDayKey(new Date("2026-07-08T15:30:00.000Z"))).toBe("2026-07-08");
    // boundary: 23:59:59.999Z is same day, 00:00:00Z is next day
    expect(formatDayKey(new Date("2026-07-08T23:59:59.999Z"))).toBe("2026-07-08");
    expect(formatDayKey(new Date("2026-07-09T00:00:00.000Z"))).toBe("2026-07-09");
  });

  test("parseDayKey -> UTC midnight of that day", () => {
    expect(parseDayKey("2026-07-08").toISOString()).toBe("2026-07-08T00:00:00.000Z");
  });

  test("startOfDayUTC / endOfDayUTC bracket exactly one UTC day", () => {
    const mid = new Date("2026-07-08T15:30:00.000Z");
    expect(startOfDayUTC(mid).toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(endOfDayUTC(mid).toISOString()).toBe("2026-07-08T23:59:59.999Z");
  });

  test("addDays is exact +/- 24h (UTC has no DST)", () => {
    expect(addDays(new Date("2026-07-08T00:00:00.000Z"), 6).toISOString()).toBe(
      "2026-07-14T00:00:00.000Z"
    );
    expect(addDays(new Date("2026-07-08T00:00:00.000Z"), -6).toISOString()).toBe(
      "2026-07-02T00:00:00.000Z"
    );
  });

  test("eachDayUTC includes every UTC day whose 00:00 <= end (matches eachDayOfInterval under UTC)", () => {
    // start mid-day, end just past midnight of a later day => that later day is included.
    const days = eachDayUTC(
      new Date("2026-07-01T06:00:00.000Z"),
      new Date("2026-07-04T00:05:00.000Z")
    );
    expect(days.map((d) => d.toISOString())).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
      "2026-07-04T00:00:00.000Z",
    ]);
  });

  test("parseDayParam: bare day => UTC midnight; full ISO => exact instant", () => {
    expect(parseDayParam("2026-07-08").toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(parseDayParam("2026-07-08T05:59:59.999Z").toISOString()).toBe(
      "2026-07-08T05:59:59.999Z"
    );
  });
});

describe("parseReportDateRange", () => {
  const sp = (qs: string) => new URLSearchParams(qs);

  test("no params + defaultLastDays => last-N-days window ending 'now' (raw now, not end-of-day)", () => {
    const now = new Date("2026-07-08T12:00:00.000Z");
    const { start, end } = parseReportDateRange(sp(""), { defaultLastDays: 7, now });
    // end is the raw 'now' instant (byte-identical to the prior `new Date()`)
    expect(end.toISOString()).toBe("2026-07-08T12:00:00.000Z");
    // start = end - (7-1) days
    expect(start.toISOString()).toBe("2026-07-02T12:00:00.000Z");
  });

  test("full-ISO endDate passes through EXACTLY (production UI path => byte-identical)", () => {
    const { start, end } = parseReportDateRange(
      sp("startDate=2026-07-01T06:00:00.000Z&endDate=2026-07-08T05:59:59.999Z")
    );
    expect(start?.toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(end?.toISOString()).toBe("2026-07-08T05:59:59.999Z");
  });

  test("INCLUSIVITY CONTRACT: bare-day endDate => inclusive end-of-day (23:59:59.999Z)", () => {
    const { end } = parseReportDateRange(sp("endDate=2026-07-08"));
    // Previously `new Date("2026-07-08")` = 00:00:00Z (nearly-exclusive); now inclusive.
    expect(end?.toISOString()).toBe("2026-07-08T23:59:59.999Z");
  });

  test("bare-day startDate => start of that UTC day", () => {
    const { start } = parseReportDateRange(sp("startDate=2026-07-01"));
    expect(start?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  test("no defaultLastDays => missing bounds are undefined (optional gte/lte)", () => {
    const r = parseReportDateRange(sp(""));
    expect(r.start).toBeUndefined();
    expect(r.end).toBeUndefined();
  });

  test("defaultLastDays with only endDate => start defaults to end - (N-1) days", () => {
    const { start, end } = parseReportDateRange(sp("endDate=2026-07-08T00:00:00.000Z"), {
      defaultLastDays: 7,
    });
    expect(end.toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(start.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });
});
