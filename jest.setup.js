// Learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// Lane 6 — LAYER A: the egress network interceptor.
//
// Installed FIRST, before any other setup and before any test module loads.
//
// It makes `globalThis.fetch` non-replaceable: a platform-bound request that did
// not originate inside lib/platforms/egress throws a sentinel error and fails
// that test by name. Tests that do `global.fetch = jest.fn()` still work — the
// assignment now injects a DELEGATE the guard calls, rather than removing the
// guard (codex #13).
//
// This is defense in depth, not the guarantee. The guarantee is network-level
// (the W3 proxy drive). See __tests__/support/network-interceptor.ts.
// ---------------------------------------------------------------------------
import {
  installNetworkInterceptor,
  resetNetworkDelegate,
} from "./__tests__/support/network-interceptor";

installNetworkInterceptor();

// ---------------------------------------------------------------------------
// Reconciliation Part 2 — B1-0: THE RECORDING RAW STUBS (plan P-7, pack CB0.3).
//
// The lock discipline is an ORDER: `lockFirst` is statement 1, the canonical
// prelock precedes the transaction's first consistent read, and the guards read
// what the prelock returned. None of that is observable through the Prisma
// delegates alone, because every statement that takes a lock is raw SQL. So the
// global mock records them.
//
// TWO LAYERS (REV-14 PKb-8). Each method is an OUTER jest.fn that ALWAYS
// records and then delegates to an INNER behaviour jest.fn. Per-test
// configuration (`mockResolvedValueOnce`, a SQL dispatcher) targets the inner fn
// through `__rawBehavior`, so an override can never silently switch the
// recording off — which is exactly how an order pin would rot into a pin that
// passes because nothing was recorded at all.
//
// The three names are a TRIO, not a pair: fulfil's savepoints are
// `$executeRawUnsafe`, and a route suite driving fulfil on the global mock would
// otherwise crash on an undefined method (REV-13 dev (iii)).
//
// These live at module scope (and are `mock`-prefixed, which is what lets the
// hoisted `jest.mock` factory below close over them) so the global `beforeEach`
// can clear the log and re-seed the defaults without requiring the mocked
// module — a suite that installs its OWN `@/lib/prisma` factory is untouched.
// ---------------------------------------------------------------------------

/** Every raw statement this test file has spent, in call order. */
const mockRawCalls = [];
/** The INNER behaviour fns, by method name — what a test configures. */
const mockRawBehavior = {};
/** [{ fn, make }] — re-seeded after every reset (mockReset erases the default). */
const mockRawDefaults = [];
/** The OUTER recording fns — cleared (never reset: that would remove the recording). */
const mockRawRecorders = [];
/** `at`: a module-level monotonic counter, so raw calls order among themselves. */
let mockRawSeq = 0;

// Each test starts with no injected delegate and a clean request log, so one
// suite's fetch mock can never leak into another's assertions — and with an
// empty raw-statement log whose stubs answer their documented defaults.
beforeEach(() => {
  resetNetworkDelegate();
  mockRawCalls.length = 0;
  // The outer fns' call logs are cleared with the log they write to, so
  // `$queryRaw.mock.calls[0]` and `__rawCalls[0]` always name the same
  // statement. `mockClear` and not `mockReset`: the recording IS the outer fn's
  // implementation.
  mockRawRecorders.forEach((fn) => fn.mockClear());
  mockRawDefaults.forEach(({ fn, make }) => {
    fn.mockReset();
    fn.mockImplementation(() => Promise.resolve(make()));
  });
});

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
};

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
};

// Mock window.matchMedia (skip in non-jsdom environments)
if (typeof window !== "undefined") Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // deprecated
    removeListener: jest.fn(), // deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock next-auth
jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("next-auth/react", () => ({
  useSession: jest.fn(() => ({ data: null, status: "loading" })),
  SessionProvider: ({ children }) => children,
}));

// Mock Prisma client
//
// Lane 6 (codex #19): `integration`, `systemSetting`, and `platformWriteAttempt`
// are present here because the egress gate reads all three on EVERY write
// attempt. Without them, any suite that transitively reaches the gate would see
// `undefined.findUnique` — an unrelated-suite failure that looks like a bug in
// the suite rather than a missing mock. The gate is fail-closed, so an
// unstubbed read simply blocks the write, which is the correct default here too.
//
// Multiuser substrate (contract pack T12, owned by task 1.1): the assistant
// persistence delegates. `lib/assistant/threads.ts` and `requests.ts` run their
// writes inside `prisma.$transaction`, so the SAME delegate objects back both the
// top-level client and the `tx` handed to the callback — a suite can assert on
// either. `$transaction` therefore defaults to driving its callback (array form:
// Promise.all) instead of returning undefined, and the tx object is exported as
// `__mockTx` for assertions.
jest.mock("@/lib/prisma", () => {
  const delegates = {
    product: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    product_locations: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    inventory_logs: {
      create: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
    integration: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    systemSetting: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    platformWriteAttempt: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    // Lane 6 (L-WOO): the read-only fulfillment observation feed. Present here so
    // any suite that transitively reaches the webhook hint or the poll (e.g. the
    // webhook route) sees a defined model rather than `undefined.upsert`.
    fulfillmentObservation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn(),
    },
    fulfillmentSyncState: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    fulfillmentObservationHint: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    assistantThread: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    assistantMessage: {
      create: jest.fn(),
      createMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    assistantRequest: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    assistantEvalReport: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    assistantRun: {
      create: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    // Inventory-accuracy lane (pack T1, owned by W1-1): the receiving header and
    // the exception register. Present from the schema wave onward so the W1
    // tasks that follow — the shipment routes, the count/graduate chain, the
    // exception writers — see defined delegates instead of `undefined.upsert`.
    // Both are written inside `prisma.$transaction`, so they ride the shared
    // delegate objects that back the client AND `__mockTx`.
    inboundShipment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    inventoryException: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    userCompany: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
  };

  // The raw trio (pack CB0.3). `sql` is the `Prisma.sql` object's own text —
  // the `$executeRawUnsafe` / raw-string form records what it was handed.
  const sqlTextOf = (arg) =>
    arg && typeof arg === "object" && typeof arg.sql === "string" ? arg.sql : String(arg);

  const makeRecordingRaw = (kind, make) => {
    const behavior = jest.fn(() => Promise.resolve(make()));
    mockRawDefaults.push({ fn: behavior, make });
    const recording = jest.fn((...args) => {
      mockRawCalls.push({ kind, sql: sqlTextOf(args[0]), at: mockRawSeq++ });
      return behavior(...args);
    });
    mockRawRecorders.push(recording);
    return { recording, behavior };
  };

  const rawQuery = makeRecordingRaw("query", () => []);
  const rawExecute = makeRecordingRaw("execute", () => 0);
  const rawExecuteUnsafe = makeRecordingRaw("executeUnsafe", () => 0);

  const raw = {
    $queryRaw: rawQuery.recording,
    $executeRaw: rawExecute.recording,
    $executeRawUnsafe: rawExecuteUnsafe.recording,
  };
  mockRawBehavior.$queryRaw = rawQuery.behavior;
  mockRawBehavior.$executeRaw = rawExecute.behavior;
  mockRawBehavior.$executeRawUnsafe = rawExecuteUnsafe.behavior;

  // `tx` IS the client's delegate set (identical object references), minus the
  // transaction entry point itself. The raw trio is shared the same way: ONE fn
  // per method, on both, so an assertion on either sees every call.
  const mockTx = { ...delegates, ...raw };
  const client = {
    ...delegates,
    ...raw,
    $transaction: jest.fn((arg) => (typeof arg === "function" ? arg(mockTx) : Promise.all(arg))),
  };

  return {
    __esModule: true,
    default: client,
    __mockTx: mockTx,
    __rawCalls: mockRawCalls,
    __rawBehavior: mockRawBehavior,
  };
});
