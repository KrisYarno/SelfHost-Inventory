/**
 * THE ONE READER FOR AN API ERROR BODY, CLIENT-SIDE.
 *
 * Reconciliation Part 2, pack REV-22 F7 (OCb-6). Client-safe and
 * dependency-free on purpose: every surface that reads a failed `fetch` imports
 * this and nothing else.
 *
 * TWO SHAPES reach the browser and both are live:
 *
 *   FLAT   `{ error: string, code?: string }` — what `apiHandler` emits today
 *          (`errorResponse`), including every `AppError` the B1 routes throw.
 *   NESTED `{ error: { message, code, context } }` — the legacy shape the
 *          workbench/journal dialogs were originally written against, still
 *          produced by the hand-rolled routes.
 *
 * A reader that knows only the nested shape silently drops the code AND the
 * sentence of every flat body: the operator gets "Failed to process order"
 * where the server said "Product 5: Insufficient inventory: current 0, trying
 * to remove 3". That is the bug this closes.
 *
 * `message` is `''` when the body carries no readable sentence — the caller
 * supplies its OWN domain fallback (`apiErrorMessage`), because "Failed to
 * fulfill order" and "Failed to submit adjustments" are not interchangeable.
 */

export interface ApiErrorRead {
  /** The server's own sentence, or `''` when the body carries none. */
  message: string;
  /** The wire code (`INSUFFICIENT_STOCK`, `ORDER_GONE`, ...), or null. */
  code: string | null;
  /** Whatever the nested shape carried alongside — batch results, and so on. */
  context?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readApiError(body: unknown): ApiErrorRead {
  if (!isRecord(body)) {
    return { message: "", code: null, context: undefined };
  }

  const error = body.error;

  // The legacy NESTED shape. Its own `context` is the one the batch-failure
  // branches read, so it rides through untouched.
  if (isRecord(error)) {
    return {
      message: readString(error.message) ?? "",
      code: readString(error.code),
      context: error.context,
    };
  }

  // The FLAT shape: the sentence is `error`, the code is a sibling key. Any
  // other sibling (`currentVersion`/`expectedVersion` on a 409) is left alone —
  // the branches that want those read the body directly.
  return {
    message: readString(error) ?? "",
    code: readString(body.code),
    context: body.context,
  };
}

/**
 * Honest copy for the codes B1 put on the wire.
 *
 * ONLY codes whose server sentence is not operator-facing belong here.
 * `TOO_MANY_KEYS` ("too many restorations in one request — split it") and
 * `INSUFFICIENT_STOCK` ("Product 5: Insufficient inventory: current 0, trying
 * to remove 3") already say the true thing AND what to do about it, so they
 * pass through VERBATIM — do not "improve" them here, the server owns them.
 * `ORDER_GONE`'s sentence names an internal order id and no next step, so this
 * is the one the client re-says.
 */
const CLIENT_COPY: Record<string, string> = {
  ORDER_GONE: "this order no longer exists — refresh and re-check",
};

/**
 * The sentence to show for a failed response body: the client's own copy for a
 * code that needs it, else the server's sentence, else the caller's fallback.
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  const { message, code } = readApiError(body);
  if (code !== null && Object.prototype.hasOwnProperty.call(CLIENT_COPY, code)) {
    return CLIENT_COPY[code];
  }
  return message || fallback;
}
