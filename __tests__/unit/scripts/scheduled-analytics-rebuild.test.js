// @jest-environment node
//
// Unit test for the PROD analytics scheduler sidecar's PURE decision function.
// Importing the script must NOT start the loop (it is guarded by
// `if (require.main === module)`), so this require is side-effect-free.
const {
  decideJobs,
  dayKey,
  weekKey,
} = require("../../../scripts/scheduled-analytics-rebuild");

// Cadence used across cases: nightly at 03:00 UTC, weekly full on Sunday (DOW 0)
// at 04:00 UTC.
const cfg = { nightlyHourUtc: 3, fullDow: 0, fullHourUtc: 4 };

// Fixed reference dates (UTC). 2026-06-03 is a Wednesday; 2026-06-07 is a Sunday.
const WED_0200 = new Date("2026-06-03T02:00:00.000Z"); // before nightly hour
const WED_0300 = new Date("2026-06-03T03:00:00.000Z"); // at nightly hour
const WED_0530 = new Date("2026-06-03T05:30:00.000Z"); // after nightly hour
const SUN_0330 = new Date("2026-06-07T03:30:00.000Z"); // full day, before full hour, after nightly hour
const SUN_0400 = new Date("2026-06-07T04:00:00.000Z"); // full day, at full hour
const SUN_0600 = new Date("2026-06-07T06:00:00.000Z"); // full day, after full hour

test("importing the module does not throw and exports decideJobs", () => {
  expect(typeof decideJobs).toBe("function");
});

test("(a) before nightly hour, nothing run today => no jobs, state unchanged", () => {
  const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
  const out = decideJobs(WED_0200, state, cfg);
  expect(out.jobs).toEqual([]);
  expect(out.state).toEqual(state);
});

test("(b) at/after nightly hour, not yet run today => 2 nightly jobs + lastNightlyDay set", () => {
  const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
  const out = decideJobs(WED_0300, state, cfg);
  expect(out.jobs).toEqual([
    { job: "sales", mode: "nightly" },
    { job: "snapshots", mode: "nightly" },
  ]);
  expect(out.state.lastNightlyDay).toBe("2026-06-03");
  expect(out.state.lastNightlyDay).toBe(dayKey(WED_0300));
  // full marker untouched on a plain nightly
  expect(out.state.lastFullWeek).toBeUndefined();
});

test("(b') well after nightly hour also fires nightly when not run today", () => {
  const out = decideJobs(WED_0530, { lastNightlyDay: undefined }, cfg);
  expect(out.jobs.map((j) => j.mode)).toEqual(["nightly", "nightly"]);
  expect(out.state.lastNightlyDay).toBe("2026-06-03");
});

test("(c) already ran nightly today => no jobs, state unchanged", () => {
  const state = { lastNightlyDay: "2026-06-03", lastFullWeek: undefined };
  const out = decideJobs(WED_0530, state, cfg);
  expect(out.jobs).toEqual([]);
  expect(out.state).toEqual(state);
});

test("(d) on full DOW at/after full hour, not run this week => 2 full jobs + BOTH state fields set", () => {
  const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
  const out = decideJobs(SUN_0400, state, cfg);
  expect(out.jobs).toEqual([
    { job: "sales", mode: "full" },
    { job: "snapshots", mode: "full" },
  ]);
  expect(out.state.lastFullWeek).toBe(weekKey(SUN_0400));
  // a full also covers today's nightly
  expect(out.state.lastNightlyDay).toBe("2026-06-07");
});

test("(d') full DOW after full hour also fires the full", () => {
  const out = decideJobs(SUN_0600, {}, cfg);
  expect(out.jobs.map((j) => j.mode)).toEqual(["full", "full"]);
});

test("(e) full already ran this week (still the full day/hour) => no full; nightly already covered => no jobs", () => {
  // After a full ran, lastNightlyDay was also advanced to today, so nothing is due.
  const week = weekKey(SUN_0600);
  const state = { lastNightlyDay: "2026-06-07", lastFullWeek: week };
  const out = decideJobs(SUN_0600, state, cfg);
  expect(out.jobs).toEqual([]);
  expect(out.state).toEqual(state);
});

test("precedence: on full day at full hour, full WINS over nightly even if nightly not yet run", () => {
  // nightly not run today, but it's the full window => we get FULL jobs, not nightly.
  const out = decideJobs(SUN_0400, { lastNightlyDay: undefined, lastFullWeek: undefined }, cfg);
  expect(out.jobs.every((j) => j.mode === "full")).toBe(true);
});

test("full day BEFORE full hour but AFTER nightly hour, full done this week => falls through to nightly", () => {
  // lastFullWeek set (already did the full earlier), nightly not yet today,
  // now is 03:30 (>= nightly hour, < full hour) => nightly fires.
  const week = weekKey(SUN_0330);
  const out = decideJobs(SUN_0330, { lastFullWeek: week, lastNightlyDay: undefined }, cfg);
  expect(out.jobs).toEqual([
    { job: "sales", mode: "nightly" },
    { job: "snapshots", mode: "nightly" },
  ]);
  expect(out.state.lastNightlyDay).toBe("2026-06-07");
});
