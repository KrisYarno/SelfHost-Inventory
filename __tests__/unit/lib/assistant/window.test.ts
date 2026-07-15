/**
 * @jest-environment node
 *
 * The shared window resolver (assistant toolsuite breadth, spec §4 W0-WIN): N day-keys
 * (from = to − (N−1)), `to`-anchoring, the from+relativeDays mutual-exclusion throw,
 * and the echoed source.
 */

import { resolveWindow } from "@/lib/assistant/window";
import { AppError } from "@/lib/error-handling";

const NOW = new Date("2026-07-14T12:00:00.000Z");

describe("resolveWindow (spec §4 W0-WIN)", () => {
  it("relativeDays: N ⇒ exactly N day-keys (from = to − (N−1)), source relative", () => {
    expect(resolveWindow({ relativeDays: 30 }, NOW)).toEqual({
      from: "2026-06-15",
      to: "2026-07-14",
      days: 30,
      source: "relative",
    });
  });

  it("relativeDays: 1 ⇒ a single day", () => {
    expect(resolveWindow({ relativeDays: 1 }, NOW)).toEqual({
      from: "2026-07-14",
      to: "2026-07-14",
      days: 1,
      source: "relative",
    });
  });

  it("`to` WITHOUT `from` anchors the window to `to`, not to today", () => {
    expect(resolveWindow({ to: "2026-03-10", relativeDays: 7 }, NOW)).toEqual({
      from: "2026-03-04",
      to: "2026-03-10",
      days: 7,
      source: "relative",
    });
  });

  it("explicit from/to echoes source explicit + inclusive day count", () => {
    expect(resolveWindow({ from: "2026-01-01", to: "2026-01-31" }, NOW)).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
      days: 31,
      source: "explicit",
    });
  });

  it("`from` WITHOUT `to` defaults `to` to today", () => {
    expect(resolveWindow({ from: "2026-07-10" }, NOW)).toEqual({
      from: "2026-07-10",
      to: "2026-07-14",
      days: 5,
      source: "explicit",
    });
  });

  it("neither from nor relativeDays ⇒ defaultRelativeDays day-keys ending today, source default", () => {
    expect(resolveWindow({}, NOW, 30)).toEqual({
      from: "2026-06-15",
      to: "2026-07-14",
      days: 30,
      source: "default",
    });
  });

  it("from + relativeDays together THROWS AppError(VALIDATION, 400)", () => {
    expect(() => resolveWindow({ from: "2026-01-01", relativeDays: 5 }, NOW)).toThrow(AppError);
    try {
      resolveWindow({ from: "2026-01-01", relativeDays: 5 }, NOW);
      throw new Error("expected resolveWindow to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("VALIDATION");
      expect((e as AppError).statusCode).toBe(400);
      expect((e as AppError).message).toBe("from and relativeDays are mutually exclusive");
    }
  });
});
