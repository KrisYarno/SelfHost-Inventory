/**
 * __tests__/support/network-interceptor.ts — LAYER A of the egress enforcement.
 *
 * Installed globally from jest.setup.js, before any test module loads.
 *
 * WHAT IT ANSWERS: "did a platform-bound request originate outside
 * lib/platforms/egress?" If yes, it throws a SENTINEL error and fails that test
 * by name.
 *
 * ---------------------------------------------------------------------------
 * HOW IT KNOWS (RV-1 — NOT stack inspection)
 * ---------------------------------------------------------------------------
 * The original design read `new Error().stack` to find the caller. That is both
 * forgeable and unstable under jest's transforms and source maps. Instead,
 * `lib/platforms/egress/http.ts` attaches a module-scoped Symbol (EGRESS_MARK) to
 * the fetch init. The mark is a property of the REQUEST, not of the stack.
 *
 * Forging it requires importing `lib/platforms/egress/mark` from outside the
 * egress module — which is itself a CI failure under LAYER B (the import
 * boundary). That is the point of having three independent layers rather than one
 * clever one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GUARD IS NON-REPLACEABLE (codex #13)
 * ---------------------------------------------------------------------------
 * Twenty-two existing suites do `global.fetch = jest.fn()`. An interceptor
 * installed in setupFilesAfterEnv would be silently clobbered by every one of
 * them — the guard would be present in exactly the tests that don't need it and
 * absent from the ones that do.
 *
 * So `globalThis.fetch` is defined as a NON-CONFIGURABLE ACCESSOR:
 *   - the getter returns the guard (never the mock),
 *   - the setter installs the assigned function as an INJECTED DELEGATE.
 *
 * `global.fetch = jest.fn()` therefore keeps working — it just no longer removes
 * the guard. The guard runs first, and then calls the delegate. And because the
 * getter hands back a Proxy that forwards property reads to the current delegate,
 * `expect(global.fetch).toHaveBeenCalledWith(...)` and
 * `(global.fetch as jest.Mock).mockResolvedValueOnce(...)` both still work.
 *
 * `Object.defineProperty(globalThis, "fetch", ...)` on a non-configurable
 * property throws, so a test cannot re-take the slot even deliberately.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS *NOT* (RV-2)
 * ---------------------------------------------------------------------------
 * This is DEFENSE IN DEPTH, not the guarantee. An in-process patch can never
 * cover `http.get`, captured originals held before install, undici, raw net/tls,
 * worker threads, child processes, or a transitive dependency's own client. The
 * real guarantee at drive time is NETWORK-LEVEL: W3 runs the app with no route to
 * the internet except a recording/deny proxy, and asserts zero platform-bound
 * connections AT THE BOUNDARY.
 */

import { isEgressMarked } from "@/lib/platforms/egress/mark";

/**
 * The exact string every bypass fixture asserts on. If you are here because a
 * test failed with this in the message: a platform-bound HTTP request was made
 * from outside lib/platforms/egress. That is not a test problem. Route it through
 * `platformRead` / `pushStockStatus` / `pushOrderStatus`.
 */
export const EGRESS_SENTINEL = "LANE6_EGRESS_BYPASS";

export interface InterceptedRequest {
  url: string;
  method: string;
  marked: boolean;
}

class Interceptor {
  /** Every platform-bound request seen this test, marked or not. */
  platformRequests: InterceptedRequest[] = [];
  /** Platform-bound requests that did NOT come from egress. */
  violations: InterceptedRequest[] = [];

  reset(): void {
    this.platformRequests = [];
    this.violations = [];
  }
}

export const interceptor = new Interceptor();

/**
 * Is this URL bound for a merchant platform?
 *
 * Matched on PATH SHAPE rather than host, so it catches any store host a test
 * invents (store.test, store.example.com, awake.store, ...) without an allowlist
 * anyone has to remember to update.
 */
const PLATFORM_PATTERNS: RegExp[] = [
  /\/wp-json\//i, // WooCommerce REST
  /\/admin\/api\//i, // Shopify Admin REST
  /\.myshopify\.com/i,
];

export function isPlatformBound(url: string): boolean {
  return PLATFORM_PATTERNS.some((p) => p.test(url));
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

function methodOf(init: unknown, input: unknown): string {
  const fromInit = (init as { method?: string } | undefined)?.method;
  if (fromInit) return fromInit.toUpperCase();
  if (input && typeof input === "object" && "method" in input) {
    return String((input as { method: unknown }).method).toUpperCase();
  }
  return "GET";
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/** The real fetch, captured at install time. */
const REAL_FETCH: typeof fetch | undefined =
  typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;

/** What a test most recently assigned to `global.fetch`. */
let delegate: unknown;

// async so a thrown sentinel becomes a REJECTED PROMISE, not a synchronous
// throw — `await expect(fetch(...)).rejects.toThrow()` depends on that, and real
// fetch signals errors by rejection too.
async function guardedFetch(...args: unknown[]): Promise<Response> {
  const [input, init] = args;
  const url = urlOf(input);

  if (isPlatformBound(url)) {
    const marked = isEgressMarked(init);
    const record: InterceptedRequest = {
      url,
      method: methodOf(init, input),
      marked,
    };
    interceptor.platformRequests.push(record);

    if (!marked) {
      interceptor.violations.push(record);
      throw new Error(
        `${EGRESS_SENTINEL}: a ${record.method} request to a platform host was issued from ` +
          `OUTSIDE lib/platforms/egress (${url}). Every platform call must go through ` +
          `platformRead() / pushStockStatus() / pushOrderStatus(), which gate, audit, ` +
          `origin-pin, and credential-scope it. See docs: Lane 6 egress lockdown.`
      );
    }
  }

  const target = (delegate ?? REAL_FETCH) as
    | ((...a: unknown[]) => Promise<Response>)
    | undefined;

  if (!target) {
    throw new Error(
      `${EGRESS_SENTINEL}: no fetch available (no delegate injected and no real fetch captured)`
    );
  }

  // Forward with the EXACT arity we were called with, so a test asserting
  // `toHaveBeenCalledWith(url)` (one arg) still matches.
  return target(...args);
}

/**
 * Reads of `global.fetch` return this proxy. Calling it runs the guard; reading
 * a property off it (`.mock`, `._isMockFunction`, `.mockResolvedValueOnce`, ...)
 * forwards to whatever the test injected — so jest's matchers behave exactly as
 * they did before the guard existed.
 */
const NEVER_FORWARD = new Set<PropertyKey>(["call", "apply", "bind", "constructor"]);

const fetchProxy = new Proxy(guardedFetch as unknown as typeof fetch, {
  apply: (_target, _thisArg, args) =>
    guardedFetch(...args) as unknown as Response,

  get: (target, prop, receiver) => {
    const current = delegate as Record<PropertyKey, unknown> | undefined;
    if (current != null && !NEVER_FORWARD.has(prop) && prop in Object(current)) {
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    }
    return Reflect.get(target, prop, receiver);
  },

  set: (target, prop, value) => {
    const current = delegate as Record<PropertyKey, unknown> | undefined;
    if (current != null) {
      (current as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    }
    return Reflect.set(target, prop, value);
  },
});

/** Marks the installed accessor so we can recognise (and refuse to re-wrap) it. */
const INSTALLED = Symbol.for("lane6.egress.interceptor.installed");

/**
 * Install the guard. Idempotent — safe to call from a setup file that jest may
 * evaluate more than once across projects.
 *
 * Note on configurability: jest runs each test file with a `globalThis` that is a
 * Proxy, and the Proxy invariant forbids reporting a property as
 * NON-configurable unless the target already holds it that way — which it never
 * does for `fetch`. So we cannot make the SLOT non-redefinable here.
 *
 * That does not weaken the codex #13 guarantee, because the guarantee comes from
 * fetch being an ACCESSOR, not from the slot being locked: `global.fetch = mock`
 * invokes the setter (which injects a delegate the guard calls) rather than
 * replacing the property. Every one of the 22 existing suites keeps working, and
 * none of them can remove the guard by assignment. `assertInterceptorInstalled`
 * detects the only remaining tamper (a deliberate defineProperty) by checking the
 * accessor is still present.
 */
export function installNetworkInterceptor(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (descriptor && descriptor.get && (descriptor.get as unknown as { [k: symbol]: unknown })[INSTALLED]) {
    return; // already installed
  }

  const getter = function fetchGetter(): typeof fetch {
    return fetchProxy;
  };
  (getter as unknown as { [k: symbol]: unknown })[INSTALLED] = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: true,
    get: getter,
    set(value: unknown) {
      // A test "replacing" fetch actually injects a delegate the guard calls.
      //
      // Guard against self-assignment. A very common pattern is
      //   const real = global.fetch;  // captures the guard PROXY
      //   ...; global.fetch = real;   // "restore"
      // Assigning the proxy back as the delegate would make the guard call
      // itself forever. Treat "restore the guard" as "clear the delegate" so it
      // falls back to the captured real fetch.
      delegate = value === fetchProxy ? undefined : value;
    },
  });

  patchNodeHttp();
}

// ---------------------------------------------------------------------------
// node:http / node:https .request — the low-level client (codex #18)
// ---------------------------------------------------------------------------

/**
 * Patch `http.request` / `https.request` (which `http.get` / `https.get` call
 * internally) so a bypass that skips `fetch` entirely is still caught. A
 * fetch-only guard would miss `https.request`, `undici`, and anything built on
 * the raw client — which is exactly the route the https bypass fixture takes.
 */
function patchNodeHttp(): void {
  for (const moduleName of ["http", "https"] as const) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(`node:${moduleName}`) as {
      request: (...args: unknown[]) => unknown;
      __lane6Patched?: boolean;
    };
    if (mod.__lane6Patched) continue;

    const original = mod.request.bind(mod);
    mod.request = (...args: unknown[]) => {
      const first = args[0];
      let url = "";
      if (typeof first === "string") url = first;
      else if (first instanceof URL) url = first.toString();
      else if (first && typeof first === "object" && "href" in first) {
        url = String((first as { href: unknown }).href);
      } else if (first && typeof first === "object") {
        const o = first as { hostname?: string; host?: string; path?: string };
        url = `https://${o.hostname ?? o.host ?? ""}${o.path ?? ""}`;
      }

      if (isPlatformBound(url)) {
        // http.request has no fetch-style init to carry the egress mark. Egress
        // never uses the raw client (it uses fetch), so ANY platform-bound
        // raw-client call is by definition a bypass.
        interceptor.violations.push({ url, method: "RAW", marked: false });
        throw new Error(
          `${EGRESS_SENTINEL}: a raw ${moduleName}.request to a platform host was issued ` +
            `outside lib/platforms/egress (${url}). Use the egress chokepoint.`
        );
      }

      return original(...args);
    };
    mod.__lane6Patched = true;
  }
}

/** Drop any injected delegate (called between tests). */
export function resetNetworkDelegate(): void {
  delegate = undefined;
  interceptor.reset();
}

/**
 * Assert the guard is still installed. Called per-suite: if a future change makes
 * the property replaceable again, every suite says so loudly instead of silently
 * losing the protection.
 */
export function assertInterceptorInstalled(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const installed =
    !!descriptor?.get &&
    (descriptor.get as unknown as { [k: symbol]: unknown })[INSTALLED] === true;
  if (!installed) {
    throw new Error(
      `${EGRESS_SENTINEL}: the network interceptor is NOT installed — ` +
        `globalThis.fetch is not the guarded accessor. The egress guard has been lost.`
    );
  }
}
