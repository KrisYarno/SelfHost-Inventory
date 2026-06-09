import { formatDateTime, formatShortDateTime, formatDelta } from "@/lib/utils";

test("formatDateTime renders 'MMM dd, yyyy HH:mm'", () => {
  expect(formatDateTime(new Date(2026, 5, 9, 14, 5))).toBe("Jun 09, 2026 14:05");
});
test("formatShortDateTime renders 'MMM dd, HH:mm'", () => {
  expect(formatShortDateTime(new Date(2026, 5, 9, 14, 5))).toBe("Jun 09, 14:05");
});
test("formatDelta signs values", () => {
  expect(formatDelta(3)).toBe("+3");
  expect(formatDelta(-2)).toBe("-2");
  expect(formatDelta(0)).toBe("0");
});
