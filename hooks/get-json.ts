// ---------------------------------------------------------------------------
// The read transport the TanStack Query hooks share (reconciliation Part 2,
// pack § P2-B3-1, B3-1b). MOVED UNCHANGED out of `hooks/use-admin.ts`, which
// imports it from here and re-exports `ApiError`, so a hook outside the admin
// surface (the order search the adjust dialog uses) can read through the same
// helper and throw the same error shape without importing the admin module.
//
// A LEAF: nothing here imports anything.
// ---------------------------------------------------------------------------

export interface ApiError extends Error {
  status?: number;
  /**
   * The server's OWN `error` sentence, when the response carried one. A 4xx is
   * the server telling the operator what is wrong with the request they made —
   * a window over the span cap, a cursor from another filter — and that sentence
   * is the whole repair, so the surfaces that can act on it render it verbatim
   * (QA-5). `message` stays the generic status line, so nothing that toasts an
   * ApiError today starts leaking server prose it never asked for.
   */
  serverMessage?: string;
}

/** The `{ error }` envelope, when there is one. A body-less failure is not an error here. */
async function readErrorBody(res: Response): Promise<{ error?: unknown }> {
  try {
    return (await res.json()) as { error?: unknown };
  } catch {
    return {};
  }
}

/** GET helper for queries: throws Error & { status } so callers can branch on 401. */
export async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await readErrorBody(res);
    const err = new Error(`Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    if (typeof body.error === "string" && body.error.length > 0) err.serverMessage = body.error;
    throw err;
  }
  return res.json() as Promise<T>;
}
