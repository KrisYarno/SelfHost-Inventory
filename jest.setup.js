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

// Each test starts with no injected delegate and a clean request log, so one
// suite's fetch mock can never leak into another's assertions.
beforeEach(() => {
  resetNetworkDelegate();
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
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
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
    $transaction: jest.fn(),
  },
}));
