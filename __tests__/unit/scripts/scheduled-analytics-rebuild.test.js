// @jest-environment node
//
// Unit test for the PROD analytics scheduler sidecar's PURE decision function.
// Importing the script must NOT start the loop (it is guarded by
// `if (require.main === module)`), so this require is side-effect-free.
const {
  decideJobs,
  dayKey,
  weekKey,
  allOk,
  runJob,
  sendHeartbeat,
  tickOnce,
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

// ---------------------------------------------------------------------------
// allOk — the pure gate that decides whether a tick advances its dedup marker.
// State advances ONLY when every job returned "ok"; any "skipped"/"error" (or an
// empty set) blocks the advance so the same decision re-fires next tick.
// ---------------------------------------------------------------------------
describe("allOk (dedup-advance gate)", () => {
  test("exported as a function", () => {
    expect(typeof allOk).toBe("function");
  });
  test("all jobs ok => true (advance)", () => {
    expect(allOk(["ok", "ok"])).toBe(true);
    expect(allOk(["ok"])).toBe(true);
  });
  test("any skipped (lock held / flag off) => false (do NOT advance)", () => {
    expect(allOk(["ok", "skipped"])).toBe(false);
    expect(allOk(["skipped", "ok"])).toBe(false);
    expect(allOk(["skipped", "skipped"])).toBe(false);
  });
  test("any error (fetch threw / non-2xx) => false (do NOT advance)", () => {
    expect(allOk(["ok", "error"])).toBe(false);
    expect(allOk(["error"])).toBe(false);
    expect(allOk(["skipped", "error"])).toBe(false);
  });
  test("empty (no jobs fired) => false (nothing to record)", () => {
    expect(allOk([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tick gate composition: decideJobs + allOk together must (a) advance the dedup
// marker when all jobs are "ok", and (b) leave state UNADVANCED on any
// "skipped"/"error" so the SAME decision re-fires on the next tick. This mirrors
// `tick`'s body: `if (allOk(statuses)) Object.assign(state, decision.state)`.
// ---------------------------------------------------------------------------
describe("tick dedup-advance gate (decideJobs + allOk)", () => {
  // Faithful re-implementation of tick's advance rule (tick is a closure inside main()).
  function simulateTick(now, state, statusesFor) {
    const decision = decideJobs(now, state, cfg);
    if (decision.jobs.length === 0) return { fired: false, advanced: false, state };
    const statuses = decision.jobs.map(() => statusesFor);
    const advanced = allOk(statuses);
    if (advanced) Object.assign(state, decision.state);
    return { fired: true, advanced, state };
  }

  test("all jobs ok => marker advances; the next tick at the same time is a no-op", () => {
    const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
    const first = simulateTick(WED_0300, state, "ok");
    expect(first.fired).toBe(true);
    expect(first.advanced).toBe(true);
    expect(state.lastNightlyDay).toBe("2026-06-03");
    // Same time again: nightly already recorded => nothing due.
    const second = decideJobs(WED_0300, state, cfg);
    expect(second.jobs).toEqual([]);
  });

  test("a 'skipped' (lock held) job => marker does NOT advance; the SAME nightly re-fires next tick", () => {
    const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
    const first = simulateTick(WED_0300, state, "skipped");
    expect(first.fired).toBe(true);
    expect(first.advanced).toBe(false);
    expect(state.lastNightlyDay).toBeUndefined(); // unadvanced
    // Next tick (still after nightly hour, marker untouched): the nightly fires AGAIN.
    const retry = decideJobs(WED_0530, state, cfg);
    expect(retry.jobs).toEqual([
      { job: "sales", mode: "nightly" },
      { job: "snapshots", mode: "nightly" },
    ]);
  });

  test("an 'error' job => marker does NOT advance; the SAME weekly full re-fires next tick", () => {
    const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
    const first = simulateTick(SUN_0400, state, "error");
    expect(first.fired).toBe(true);
    expect(first.advanced).toBe(false);
    expect(state.lastFullWeek).toBeUndefined();
    expect(state.lastNightlyDay).toBeUndefined();
    // Next tick on the same full day/hour: the FULL jobs fire again (not downgraded to nightly).
    const retry = decideJobs(SUN_0600, state, cfg);
    expect(retry.jobs).toEqual([
      { job: "sales", mode: "full" },
      { job: "snapshots", mode: "full" },
    ]);
  });

  test("mixed ok+error => marker does NOT advance (partial success is not success)", () => {
    const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
    const decision = decideJobs(WED_0300, state, cfg);
    const statuses = ["ok", "error"]; // sales ok, snapshots failed
    expect(allOk(statuses)).toBe(false);
    if (allOk(statuses)) Object.assign(state, decision.state);
    expect(state.lastNightlyDay).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runJob — HTTP-outcome classification. The status it returns is what the tick
// loop feeds into allOk, so these three outcomes are the contract:
//   2xx + body.skipped !== true => "ok"
//   2xx + body.skipped === true => "skipped"
//   fetch throws / non-2xx      => "error"
// ---------------------------------------------------------------------------
describe("runJob (HTTP outcome -> status)", () => {
  const URL = "http://app:3000/api/cron/analytics-rebuild";
  let origFetch;
  let logSpy;
  let errSpy;
  beforeEach(() => {
    origFetch = global.fetch;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = origFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  function mockFetch(impl) {
    global.fetch = jest.fn(impl);
  }

  test("2xx with a real result (skipped absent/false) => 'ok' and curls the right job/mode URL", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, skipped: false, result: { rowsInserted: 3 } }),
    }));
    const status = await runJob(URL, "sek", "sales", "nightly");
    expect(status).toBe("ok");
    expect(global.fetch).toHaveBeenCalledWith(
      `${URL}?job=sales&mode=nightly`,
      expect.objectContaining({ method: "GET", headers: { authorization: "Bearer sek" } })
    );
  });

  test("2xx with skipped:true (lock held) => 'skipped'", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, skipped: true, result: { rowsInserted: 0 } }),
    }));
    expect(await runJob(URL, "sek", "snapshots", "full")).toBe("skipped");
  });

  test("2xx with skipped:true and flag-off reason => 'skipped'", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, skipped: true, reason: "analyticsRebuildEnabled is off" }),
    }));
    expect(await runJob(URL, "sek", "sales", "nightly")).toBe("skipped");
  });

  test("non-2xx => 'error'", async () => {
    mockFetch(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    expect(await runJob(URL, "sek", "sales", "nightly")).toBe("error");
  });

  test("fetch throws => 'error' (transient, retried next tick)", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await runJob(URL, "sek", "sales", "full")).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// sendHeartbeat — the every-tick liveness ping. Curls ?op=heartbeat&env=<0|1>
// with the Bearer secret; best-effort (a failed heartbeat never blocks a tick).
// ---------------------------------------------------------------------------
describe("sendHeartbeat (liveness ping)", () => {
  const URL = "http://app:3000/api/cron/analytics-rebuild";
  let origFetch;
  let logSpy;
  let errSpy;
  beforeEach(() => {
    origFetch = global.fetch;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = origFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test("2xx => true, curls ?op=heartbeat with env=1 and the Bearer secret", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    const ok = await sendHeartbeat(URL, "sek", true);
    expect(ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      `${URL}?op=heartbeat&env=1`,
      expect.objectContaining({ method: "GET", headers: { authorization: "Bearer sek" } })
    );
  });

  test("env=0 when the sidecar reports itself disabled", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    await sendHeartbeat(URL, "sek", false);
    expect(global.fetch).toHaveBeenCalledWith(
      `${URL}?op=heartbeat&env=0`,
      expect.anything()
    );
  });

  test("non-2xx => false (logged, tick continues)", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401 }));
    expect(await sendHeartbeat(URL, "sek", true)).toBe(false);
  });

  test("fetch throws => false (best-effort, never blocks a tick)", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await sendHeartbeat(URL, "sek", true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tickOnce — the extracted single-tick body (spec P5, codex #12). Disabled ticks
// heartbeat env=0 and dispatch NO jobs; enabled ticks heartbeat env=1 then run
// due jobs. Both use `fetch` (heartbeat + runJob), so a mocked fetch proves the
// heartbeat body AND that no job URL is ever hit while disabled.
// ---------------------------------------------------------------------------
describe("tickOnce (heartbeat + optional dispatch)", () => {
  const URL = "http://app:3000/api/cron/analytics-rebuild";
  let origFetch;
  let logSpy;
  let errSpy;
  let warnSpy;
  beforeEach(() => {
    origFetch = global.fetch;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = origFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("disabled: heartbeats env=0 and dispatches NO jobs (decideJobs skipped)", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }));
    const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
    // now = full day at full hour: a job WOULD be due if enabled — proves the guard.
    const res = await tickOnce({ url: URL, secret: "sek", enabled: false, state, cfg, now: SUN_0400 });

    expect(res.disabled).toBe(true);
    expect(res.statuses).toEqual([]);
    // Exactly one fetch: the heartbeat, with env=0.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `${URL}?op=heartbeat&env=0`,
      expect.objectContaining({ method: "GET", headers: { authorization: "Bearer sek" } })
    );
    // No job dispatch at all.
    expect(global.fetch.mock.calls.some((c) => String(c[0]).includes("job="))).toBe(false);
    // Dedup state untouched.
    expect(state).toEqual({ lastNightlyDay: undefined, lastFullWeek: undefined });
  });

  test("enabled: heartbeats env=1, dispatches the due jobs, advances state on all-ok", async () => {
    global.fetch = jest.fn(async (target) => {
      if (String(target).includes("op=heartbeat")) return { ok: true, status: 200 };
      return { ok: true, status: 200, text: async () => JSON.stringify({ skipped: false, result: {} }) };
    });
    const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
    const res = await tickOnce({ url: URL, secret: "sek", enabled: true, state, cfg, now: WED_0300 });

    expect(res.heartbeat).toBe(true);
    expect(res.statuses).toEqual(["ok", "ok"]);
    expect(global.fetch).toHaveBeenCalledWith(`${URL}?op=heartbeat&env=1`, expect.anything());
    const jobCalls = global.fetch.mock.calls.filter((c) => String(c[0]).includes("job="));
    expect(jobCalls.length).toBe(2);
    expect(state.lastNightlyDay).toBe("2026-06-03"); // advanced (all ok)
  });

  test("enabled but nothing due: heartbeats env=1 and dispatches no jobs", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    const state = { lastNightlyDay: undefined, lastFullWeek: undefined };
    const res = await tickOnce({ url: URL, secret: "sek", enabled: true, state, cfg, now: WED_0200 });
    expect(res.statuses).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1); // heartbeat only
    expect(global.fetch).toHaveBeenCalledWith(`${URL}?op=heartbeat&env=1`, expect.anything());
  });

  test("no secret: skips both heartbeat and dispatch", async () => {
    global.fetch = jest.fn();
    const res = await tickOnce({ url: URL, secret: "", enabled: true, state: {}, cfg });
    expect(res.heartbeat).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
