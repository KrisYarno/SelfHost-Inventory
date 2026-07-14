/**
 * lib/platforms/egress/http.ts — THE single place in this codebase that may open
 * an HTTP connection to a merchant platform.
 *
 * PRIVATE to lib/platforms/egress/. Importing it from anywhere else fails CI.
 *
 * ---------------------------------------------------------------------------
 * THE UNFORGEABLE AUTHORIZATION TOKEN (RV-1)
 * ---------------------------------------------------------------------------
 * `send()` accepts ONLY an `AuthorizedRequest` minted by `authorizeWireRequest()`
 * in this module. Authorization is tracked in a module-private `WeakSet` that is
 * never exported. A caller cannot:
 *   - construct one (object identity, not a shape, is what is checked),
 *   - copy one (spreading an authorized request produces a NEW object that is
 *     not in the WeakSet),
 *   - forge one (there is no symbol or property to guess — the set is closed
 *     over by this module and unreachable from outside).
 *
 * The original design used stack inspection ("did this call come from egress?").
 * That was replaced because stacks are forgeable and unstable under jest's
 * transforms and source maps. Object identity is neither.
 *
 * ---------------------------------------------------------------------------
 * WHAT `authorizeWireRequest` ENFORCES (REV-2 #3, #5, #8)
 * ---------------------------------------------------------------------------
 * It does NOT take a url/method/body. It takes a DISCRIMINATED UNION over the
 * three concrete wire operations this app is allowed to perform, and derives the
 * request itself. There is no generic `platformWrite(capability, url, body)` — a
 * caller cannot pair an allowed capability with an arbitrary endpoint (the
 * confused-deputy hole codex #4 found).
 *
 * For every request, read or write:
 *   - the URL is built from the Integration's OWN storeUrl, never caller input;
 *   - the scheme MUST be https: — an http:// store is BLOCKED, never upgraded;
 *   - the final origin must equal the store's origin exactly;
 *   - the final pathname must match the operation's exact template regex;
 *   - external ids must be canonical decimal (^\d+$) and are encodeURIComponent'd;
 *   - redirects are `manual` and ANY 3xx is a hard failure, never followed.
 */

import { AppError } from "@/lib/error-handling";

import { EGRESS_MARK } from "./mark";

// ---------------------------------------------------------------------------
// The token. Module-private. Never exported. Nothing below this line hands it out.
// ---------------------------------------------------------------------------

const AUTHORIZED = new WeakSet<object>();

/**
 * Compile-time brand. Declared, never defined — so no module (including this
 * one) can produce a value of this type by writing an object literal.
 *
 * The RUNTIME guarantee is the WeakSet above, not this field. The brand exists
 * so that a caller trying to hand-roll an AuthorizedRequest fails at `tsc`
 * rather than at runtime.
 */
declare const EGRESS_AUTHORIZED_BRAND: unique symbol;

/** Opaque. Only `authorizeWireRequest` can produce a value the WeakSet knows. */
export interface AuthorizedRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly [EGRESS_AUTHORIZED_BRAND]: true;
}

// ---------------------------------------------------------------------------
// Path templates (REV-2 #3). The final pathname must match EXACTLY one of these.
// ---------------------------------------------------------------------------

export const WIRE_OPERATIONS = {
  products_batch: {
    method: "POST",
    template: /^\/wp-json\/wc\/v3\/products\/batch$/,
  },
  variations_batch: {
    method: "POST",
    template: /^\/wp-json\/wc\/v3\/products\/\d+\/variations\/batch$/,
  },
  order_status: {
    method: "PUT",
    template: /^\/wp-json\/wc\/v3\/orders\/\d+$/,
  },
} as const;

export type WireOperation = keyof typeof WIRE_OPERATIONS;

/**
 * The concrete write operations. Note there is no `url` and no `method` here —
 * both are DERIVED. A caller supplies data, never a target.
 */
export type WireRequestSpec =
  | {
      op: "products_batch";
      storeUrl: string;
      credentials: { key: string; secret: string };
      updates: Array<{ id: string; stock_status: "instock" | "outofstock" }>;
    }
  | {
      op: "variations_batch";
      storeUrl: string;
      credentials: { key: string; secret: string };
      parentId: string;
      updates: Array<{ id: string; stock_status: "instock" | "outofstock" }>;
    }
  | {
      op: "order_status";
      storeUrl: string;
      credentials: { key: string; secret: string };
      externalOrderId: string;
      status: "processing" | "completed";
    };

/** A canonical decimal external id. Not "1e3", not "01 ", not "../../orders/9". */
const EXTERNAL_ID = /^\d+$/;

export type AuthorizeFailure =
  | { ok: false; reason: "invalid_target"; detail: string }
  | { ok: false; reason: "insecure_store_url"; detail: string };

export type AuthorizeResult =
  | { ok: true; request: AuthorizedRequest }
  | AuthorizeFailure;

const WRITE_TIMEOUT_MS = 10_000;

function basicAuth(key: string, secret: string): string {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
}

/**
 * Build the store origin, refusing anything that is not https.
 * An http:// store URL is BLOCKED. It is never silently upgraded — if the stored
 * config says http, the operator's intent is unclear and we do not guess with a
 * write-capable credential in hand.
 */
function resolveOrigin(
  storeUrl: string
): { ok: true; origin: string } | AuthorizeFailure {
  let parsed: URL;
  try {
    parsed = new URL(storeUrl);
  } catch {
    return {
      ok: false,
      reason: "invalid_target",
      detail: "store URL is not a valid URL",
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "insecure_store_url",
      detail: `store URL scheme is ${parsed.protocol}, refusing to send credentials`,
    };
  }
  return { ok: true, origin: parsed.origin };
}

/**
 * Construct + validate a wire request, then MINT it into the WeakSet.
 *
 * This is the only function that can produce a value `send()` will accept.
 */
export function authorizeWireRequest(spec: WireRequestSpec): AuthorizeResult {
  const originResult = resolveOrigin(spec.storeUrl);
  if (!originResult.ok) return originResult;
  const { origin } = originResult;

  let path: string;
  let body: unknown;

  switch (spec.op) {
    case "products_batch": {
      for (const u of spec.updates) {
        if (!EXTERNAL_ID.test(u.id)) {
          return {
            ok: false,
            reason: "invalid_target",
            detail: `product id is not canonical decimal: ${JSON.stringify(u.id)}`,
          };
        }
      }
      path = "/wp-json/wc/v3/products/batch";
      body = {
        update: spec.updates.map((u) => ({
          id: Number(u.id),
          stock_status: u.stock_status,
        })),
      };
      break;
    }

    case "variations_batch": {
      if (!EXTERNAL_ID.test(spec.parentId)) {
        return {
          ok: false,
          reason: "invalid_target",
          detail: `parent product id is not canonical decimal: ${JSON.stringify(spec.parentId)}`,
        };
      }
      for (const u of spec.updates) {
        if (!EXTERNAL_ID.test(u.id)) {
          return {
            ok: false,
            reason: "invalid_target",
            detail: `variation id is not canonical decimal: ${JSON.stringify(u.id)}`,
          };
        }
      }
      // encodeURIComponent even though the id is already ^\d+$ — belt and braces,
      // and it keeps the invariant true if the regex is ever loosened.
      path = `/wp-json/wc/v3/products/${encodeURIComponent(spec.parentId)}/variations/batch`;
      body = {
        update: spec.updates.map((u) => ({
          id: Number(u.id),
          stock_status: u.stock_status,
        })),
      };
      break;
    }

    case "order_status": {
      if (!EXTERNAL_ID.test(spec.externalOrderId)) {
        // THE path-injection defense. Without the ^\d+$ + template pair, a
        // crafted id like "1/../../products/5" normalizes onto a DIFFERENT
        // same-origin endpoint — an order-status write becomes a product write.
        return {
          ok: false,
          reason: "invalid_target",
          detail: `order id is not canonical decimal: ${JSON.stringify(spec.externalOrderId)}`,
        };
      }
      if (spec.status !== "processing" && spec.status !== "completed") {
        return {
          ok: false,
          reason: "invalid_target",
          detail: `refusing to set order status ${JSON.stringify(spec.status)}`,
        };
      }
      path = `/wp-json/wc/v3/orders/${encodeURIComponent(spec.externalOrderId)}`;
      body = { status: spec.status };
      break;
    }
  }

  const operation = WIRE_OPERATIONS[spec.op];

  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return { ok: false, reason: "invalid_target", detail: "could not build URL" };
  }

  // Origin pin. `new URL(path, origin)` cannot escape the origin for a path
  // starting with "/", but we assert it anyway — this check is what makes the
  // guarantee independent of URL-parser subtleties.
  if (url.origin !== origin) {
    return {
      ok: false,
      reason: "invalid_target",
      detail: `origin escaped: ${url.origin} != ${origin}`,
    };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "insecure_store_url", detail: "not https after construction" };
  }

  // THE TEMPLATE ASSERTION. The final, normalized pathname must match the
  // operation's exact shape. Any traversal, any extra segment, any query smuggled
  // into the path — all fail here.
  if (!operation.template.test(url.pathname)) {
    return {
      ok: false,
      reason: "invalid_target",
      detail: `pathname ${url.pathname} does not match the ${spec.op} template`,
    };
  }

  const request = {
    method: operation.method,
    url: url.toString(),
    body,
    headers: Object.freeze({
      Authorization: basicAuth(spec.credentials.key, spec.credentials.secret),
      "Content-Type": "application/json",
    }),
    timeoutMs: WRITE_TIMEOUT_MS,
  } as unknown as AuthorizedRequest;

  AUTHORIZED.add(request);
  return { ok: true, request };
}

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

export type SendOutcome =
  | {
      kind: "response";
      httpStatus: number;
      body: unknown;
      /** Parsed Retry-After (seconds), when the store sent one. */
      retryAfterSeconds?: number;
    }
  | { kind: "redirect"; httpStatus: number }
  | { kind: "transport"; error: string }
  /** The request left but the response was lost. The store MAY have applied it. */
  | { kind: "outcome_unknown"; error: string };

/**
 * Honor the store's own backoff request, bounded. An unparseable or absent
 * header falls back to 5s; a hostile/absurd value is clamped so a store cannot
 * pin a worker for an hour.
 */
const MAX_RETRY_AFTER_SECONDS = 60;

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Issue an authorized request.
 *
 * @param fence Re-checked as the LAST action before the bytes leave (REV-2 #4).
 *   Returns false if the config changed since authorization, in which case we
 *   abort rather than send under a stale grant.
 */
export async function send(
  request: AuthorizedRequest,
  fence?: () => Promise<boolean>
): Promise<SendOutcome | { kind: "fence_failed" }> {
  // The unforgeable check. A hand-rolled object, a spread copy, or anything that
  // did not come out of authorizeWireRequest lands here.
  if (!AUTHORIZED.has(request)) {
    throw new AppError(
      "egress: refusing to send an unauthorized request — this request was not minted by the gate",
      "EGRESS_UNAUTHORIZED_REQUEST",
      500
    );
  }

  if (fence) {
    const stillValid = await fence();
    if (!stillValid) return { kind: "fence_failed" };
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      // ANY 3xx is a failure. We never follow a redirect with a write-capable
      // credential in the Authorization header — a compromised or misconfigured
      // store could otherwise bounce it to an attacker-controlled host.
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs),
      cache: "no-store",
      // Test-time label so the CI interceptor can tell egress traffic apart from
      // a bypass. Inert at runtime — fetch ignores unknown init properties.
      [EGRESS_MARK]: true,
    } as RequestInit);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown transport error";
    // A timeout or reset AFTER the request went out is NOT a clean failure: the
    // store may well have applied the write. Never retry these (REV-2 #6) and
    // never report them as "failed" in a way a caller could read as "no effect".
    const isAmbiguous =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /socket|reset|ECONNRESET|EPIPE|network/i.test(message));
    return isAmbiguous
      ? { kind: "outcome_unknown", error: message }
      : { kind: "transport", error: message };
  }

  if (response.status >= 300 && response.status < 400) {
    return { kind: "redirect", httpStatus: response.status };
  }

  let parsed: unknown = null;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  return {
    kind: "response",
    httpStatus: response.status,
    body: parsed,
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
  };
}

// ---------------------------------------------------------------------------
// Reads (REV-2 #8 — same pinning as writes)
// ---------------------------------------------------------------------------

/** Read paths this app is allowed to call. Reads are GET-only, by construction. */
const READ_PATH_PREFIXES = ["/wp-json/wc/v3/", "/admin/api/"];

const READ_TIMEOUT_MS = 15_000;

export type ReadAuth =
  | { scheme: "basic"; key: string; secret: string }
  | { scheme: "shopify_token"; token: string };

/**
 * Issue a credentialed GET against a platform.
 *
 * Reads get the SAME treatment as writes: https-only, exact-origin pin,
 * redirect:"manual". A read cannot mutate anything, but it does carry a
 * credential — and following a redirect would hand that credential to whatever
 * host the store named.
 */
export async function sendRead(params: {
  storeUrl: string;
  path: string;
  query?: Record<string, string>;
  auth: ReadAuth;
  timeoutMs?: number;
}): Promise<Response> {
  const originResult = resolveOrigin(params.storeUrl);
  if (!originResult.ok) {
    throw new AppError(
      `Refusing to read from a non-https store URL (${originResult.reason})`,
      "EGRESS_INSECURE_STORE_URL",
      400
    );
  }
  const { origin } = originResult;

  if (!params.path.startsWith("/")) {
    throw new AppError(
      "egress: read path must be origin-relative",
      "EGRESS_INVALID_PATH",
      500
    );
  }

  const url = new URL(params.path, origin);

  if (url.origin !== origin) {
    throw new AppError(
      `egress: read escaped the store origin (${url.origin})`,
      "EGRESS_ORIGIN_ESCAPE",
      500
    );
  }
  if (!READ_PATH_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    throw new AppError(
      `egress: read path ${url.pathname} is not an allowed platform API path`,
      "EGRESS_INVALID_PATH",
      500
    );
  }

  for (const [k, v] of Object.entries(params.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> =
    params.auth.scheme === "basic"
      ? {
          Authorization: basicAuth(params.auth.key, params.auth.secret),
          "Content-Type": "application/json",
        }
      : {
          "X-Shopify-Access-Token": params.auth.token,
          "Content-Type": "application/json",
        };

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(params.timeoutMs ?? READ_TIMEOUT_MS),
    cache: "no-store",
    [EGRESS_MARK]: true,
  } as RequestInit);

  if (response.status >= 300 && response.status < 400) {
    throw new AppError(
      `Platform read was redirected (${response.status}); refusing to follow with a credential attached`,
      "EGRESS_REDIRECT",
      502
    );
  }

  return response;
}
