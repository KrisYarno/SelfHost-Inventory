/** @jest-environment jsdom */
//
// W2 Task 2.2 — the threads sidebar + the C5 NORMATIVE page states.
//
// Two halves, both spec C5:
//   1. `ThreadSidebar` in isolation — list render (titles as PLAIN TEXT, relative
//      time from `updatedAt`), the empty copy, load-more terminating on
//      `nextOffset === null`, the collapse toggle, the active highlight, and the
//      confirm -> OPTIMISTIC delete -> rollback-on-error path;
//   2. `AssistantPage` — mount-time resume from sessionStorage (incl. the 404
//      "deleted elsewhere" fork), the switch skeleton, the load-error banner that
//      KEEPS the current thread mounted, and the busy-on-open banner + 2s poll.
//
// ENV NOTE (matching lane4-assistant-ui.test.tsx): react-markdown and the
// `ai`/@ai-sdk/react chain are ESM-only and next/jest cannot transform them, so
// they are mocked. The `useChat` stub ECHOES the messages it was constructed with
// — that is how a remount-with-transcript (openThread) becomes observable here.

import * as React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="md">{children}</div>,
}));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));
jest.mock("rehype-sanitize", () => ({ __esModule: true, default: () => undefined }));

const toastErrorMock = jest.fn();
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: (...args: unknown[]) => toastErrorMock(...args) },
}));

jest.mock("ai", () => ({
  __esModule: true,
  isToolUIPart: (p: { type?: string }) => typeof p?.type === "string" && p.type.startsWith("tool-"),
  getToolName: (p: { type?: string }) => String(p?.type ?? "").replace(/^tool-/, ""),
  DefaultChatTransport: class {
    constructor(_o: unknown) {}
  },
}));

const useChatMock = jest.fn((opts?: { messages?: unknown[] }) => ({
  messages: opts?.messages ?? [],
  status: "ready",
  error: undefined,
  sendMessage: jest.fn(),
  stop: jest.fn(),
  regenerate: jest.fn(),
  clearError: jest.fn(),
}));
jest.mock("@ai-sdk/react", () => ({ useChat: (...a: unknown[]) => useChatMock(...(a as [never])) }));

jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { isAdmin: false } } }) }));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false, error: null, refreshToken: jest.fn() }),
  withCSRFHeaders: (headers: Record<string, string>, token: string | null) => ({
    ...headers,
    "x-csrf-token": token ?? "",
  }),
}));
jest.mock("next/link", () => {
  const Mock = ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
  return { __esModule: true, default: Mock };
});

import { ThreadSidebar } from "@/components/assistant/thread-sidebar";
import AssistantPage from "@/app/(app)/assistant/page";
import { LAST_THREAD_STORAGE_KEY } from "@/hooks/use-assistant-chat";

// ---------------------------------------------------------------------------
// Wire fixtures (T0 shapes — ISO date strings, nextOffset pagination)
// ---------------------------------------------------------------------------

type ListItem = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

const HOURS_AGO_2 = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const listItem = (id: string, title: string | null, updatedAt = HOURS_AGO_2): ListItem => ({
  id,
  title,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 2,
});

const listPage = (items: ListItem[], nextOffset: number | null = null, offset = 0) => ({
  items,
  limit: 20,
  offset,
  nextOffset,
});

const dtoUser = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
  metadata: null,
});
const dtoAsst = (id: string, text: string, metadata: unknown = null) => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata,
});
const dtoSystem = (id: string, text: string) => ({
  id,
  role: "system",
  parts: [{ type: "text", text }],
  metadata: null,
});

const detail = (
  id: string,
  messages: unknown[],
  activeRequest: { status: "running" } | null = null,
) => ({ id, title: null, messages, activeRequest });

// ---------------------------------------------------------------------------
// A tiny fetch router — the page and the sidebar both fetch, and the tests need
// per-route control (deferred responses, 404s, changing poll answers).
// ---------------------------------------------------------------------------

type Handler = (url: string, init?: RequestInit) => unknown;
interface Route {
  match: RegExp;
  method?: string;
  handler: Handler;
}

let routes: Route[] = [];

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function route(match: RegExp, handler: Handler, method?: string) {
  routes.unshift({ match, handler, method });
}

function installFetch() {
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const r of routes) {
      if (r.match.test(url) && (!r.method || r.method === method)) return r.handler(url, init);
    }
    throw new Error(`unrouted fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWithClient(ui: React.ReactElement) {
  const qc = newClient();
  const view = render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  return {
    ...view,
    // Re-render the SAME client (a fresh one would discard the cache under test).
    rerenderWith: (next: React.ReactElement) =>
      view.rerender(<QueryClientProvider client={qc}>{next}</QueryClientProvider>),
  };
}

// jsdom implements no Element.prototype.scrollTo, and Transcript auto-sticks to
// the bottom on every content change — a resumed transcript would throw there
// before any assertion ran.
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollTo", { value: jest.fn(), writable: true });
});

beforeEach(() => {
  routes = [];
  toastErrorMock.mockClear();
  useChatMock.mockClear();
  window.sessionStorage.clear();
  installFetch();
  // Defaults every suite can override: the readiness probe says configured, and
  // the thread list is empty.
  route(/^\/api\/assistant$/, () => jsonRes({ configured: true }));
  route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([])));
});

// ===========================================================================
// 1. ThreadSidebar
// ===========================================================================

const sidebarProps = {
  activeThreadId: null as string | null,
  streamingThreadId: null as string | null,
  onSelectThread: jest.fn(),
  onNewThread: jest.fn(),
  onThreadDeleted: jest.fn(),
};

describe("ThreadSidebar — list rendering (spec C5)", () => {
  test("titles render as PLAIN TEXT (markup in a title is inert), null title => Untitled", async () => {
    const nasty = '**bold** <b>injected</b> <img src=x onerror="alert(1)">';
    route(/^\/api\/assistant\/threads\?/, () =>
      jsonRes(listPage([listItem("t1", nasty), listItem("t2", null)])),
    );
    const { container } = renderWithClient(<ThreadSidebar {...sidebarProps} />);

    expect(await screen.findByText(nasty)).toBeInTheDocument();
    // The title is a TEXT NODE: no element ever materialises from its contents.
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  test("relative time is derived from the ISO updatedAt", async () => {
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([listItem("t1", "Alpha")])));
    renderWithClient(<ThreadSidebar {...sidebarProps} />);

    await screen.findByText("Alpha");
    expect(screen.getByText(/hours ago/)).toBeInTheDocument();
  });

  test("empty list shows the 'No conversations yet' copy", async () => {
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([])));
    renderWithClient(<ThreadSidebar {...sidebarProps} />);

    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("load-more paginates and TERMINATES on nextOffset === null", async () => {
    route(/^\/api\/assistant\/threads\?/, (url) =>
      /offset=2/.test(url)
        ? jsonRes(listPage([listItem("t3", "Gamma")], null, 2))
        : jsonRes(listPage([listItem("t1", "Alpha"), listItem("t2", "Beta")], 2, 0)),
    );
    renderWithClient(<ThreadSidebar {...sidebarProps} />);

    await screen.findByText("Alpha");
    const more = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(more);

    expect(await screen.findByText("Gamma")).toBeInTheDocument();
    // Pages accumulate...
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    // ...and the control disappears: nextOffset === null is the terminator.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  test("the active thread is highlighted (aria-current), others are not", async () => {
    route(/^\/api\/assistant\/threads\?/, () =>
      jsonRes(listPage([listItem("t1", "Alpha"), listItem("t2", "Beta")])),
    );
    renderWithClient(<ThreadSidebar {...sidebarProps} activeThreadId="t2" />);

    await screen.findByText("Alpha");
    expect(screen.getByTestId("thread-item-t2")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("thread-item-t1")).not.toHaveAttribute("aria-current");
  });

  test("an active thread the list has never seen forces ONE refetch, never a loop", async () => {
    // A brand-new thread exists server-side well before this list knows it: the
    // id rides the first response's metadata (C3) and the cached list is stale
    // for five minutes by default. Without the refetch the conversation the user
    // is having would be absent from the list of conversations.
    let listCalls = 0;
    route(/^\/api\/assistant\/threads\?/, () => {
      listCalls += 1;
      return jsonRes(listPage(listCalls === 1 ? [] : [listItem("fresh", "Fresh thread")]));
    });

    const { rerenderWith } = renderWithClient(<ThreadSidebar {...sidebarProps} />);
    await screen.findByText("No conversations yet");
    expect(listCalls).toBe(1);

    rerenderWith(<ThreadSidebar {...sidebarProps} activeThreadId="fresh" />);
    expect(await screen.findByText("Fresh thread")).toBeInTheDocument();
    expect(listCalls).toBe(2);

    // Settled: the id is now in the list, so nothing re-fires.
    await flush();
    expect(listCalls).toBe(2);
  });

  test("an active id the server never returns refetches at most once (no spin)", async () => {
    // The rows CHANGE on every call (a live list does), so react-query's
    // structural sharing cannot hide a loop behind a stable array identity: an
    // unguarded effect would invalidate -> refetch -> new items -> invalidate...
    let listCalls = 0;
    route(/^\/api\/assistant\/threads\?/, () => {
      listCalls += 1;
      return jsonRes(
        listPage([listItem("t1", "Alpha", new Date(Date.now() - listCalls * 1000).toISOString())]),
      );
    });

    const { rerenderWith } = renderWithClient(<ThreadSidebar {...sidebarProps} />);
    await screen.findByText("Alpha");
    expect(listCalls).toBe(1);

    rerenderWith(<ThreadSidebar {...sidebarProps} activeThreadId="never-listed" />);
    await flush();
    expect(listCalls).toBe(2);
    await flush();
    expect(listCalls).toBe(2);
  });

  test("the collapse toggle hides the list and restores it", async () => {
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([listItem("t1", "Alpha")])));
    renderWithClient(<ThreadSidebar {...sidebarProps} />);

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Hide conversations" }));
    expect(screen.queryByText("Alpha")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show conversations" }));
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
  });
});

describe("ThreadSidebar — delete (spec C5: confirm, optimistic, rollback + toast)", () => {
  test("confirm removes the row OPTIMISTICALLY, then rolls back with a toast on failure", async () => {
    // The `onSettled` invalidation would ALSO put Alpha back — and a rollback
    // test that a refetch can satisfy proves nothing. So the first list call is
    // answered and every later one is HELD: after the failure, the only thing
    // that can put Alpha back on screen is the snapshot rollback.
    let listCalls = 0;
    const heldRefetch = deferred<ReturnType<typeof jsonRes>>();
    route(/^\/api\/assistant\/threads\?/, () => {
      listCalls += 1;
      return listCalls === 1
        ? jsonRes(listPage([listItem("t1", "Alpha"), listItem("t2", "Beta")]))
        : heldRefetch.promise;
    });
    const pending = deferred<ReturnType<typeof jsonRes>>();
    route(/^\/api\/assistant\/threads\/t1$/, () => pending.promise, "DELETE");

    renderWithClient(<ThreadSidebar {...sidebarProps} />);
    await screen.findByText("Alpha");

    // Deleting takes a CONFIRM — the row survives merely opening the dialog.
    fireEvent.click(screen.getByTestId("thread-delete-t1"));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));

    // OPTIMISTIC: gone before the DELETE settles.
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect(screen.getByText("Beta")).toBeInTheDocument();

    // The server refuses (409 THREAD_BUSY) -> rollback + toast.
    await act(async () => {
      pending.resolve(jsonRes({ error: "Stop the response first", code: "THREAD_BUSY" }, 409));
    });

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(toastErrorMock).toHaveBeenCalled();
  });

  test("a successful delete reports the id upward (the page owns newThread)", async () => {
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([listItem("t1", "Alpha")])));
    route(/^\/api\/assistant\/threads\/t1$/, () => jsonRes({ deleted: true }), "DELETE");
    const onThreadDeleted = jest.fn();

    renderWithClient(<ThreadSidebar {...sidebarProps} onThreadDeleted={onThreadDeleted} />);
    await screen.findByText("Alpha");

    fireEvent.click(screen.getByTestId("thread-delete-t1"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete conversation" }));

    await waitFor(() => expect(onThreadDeleted).toHaveBeenCalledWith("t1"));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("delete is disabled on the thread that is actively streaming", async () => {
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([listItem("t1", "Alpha")])));
    renderWithClient(<ThreadSidebar {...sidebarProps} streamingThreadId="t1" />);

    await screen.findByText("Alpha");
    expect(screen.getByTestId("thread-delete-t1")).toBeDisabled();
  });
});

// ===========================================================================
// 2. AssistantPage — the C5 normative states
// ===========================================================================

describe("AssistantPage — mount-time resume (spec C5, per-tab sessionStorage)", () => {
  test("resumes the last-open thread and DROPS system rows from the mapping", async () => {
    window.sessionStorage.setItem(LAST_THREAD_STORAGE_KEY, "t1");
    route(/^\/api\/assistant\/threads\/t1$/, () =>
      jsonRes(
        detail("t1", [
          dtoUser("m1", "how many widgets"),
          dtoSystem("system-history-omission", "Earlier turns were omitted."),
          dtoAsst("m2", "alpha answer", { finishReason: "stop" }),
        ]),
      ),
    );

    renderWithClient(<AssistantPage />);

    expect(await screen.findByText("how many widgets")).toBeInTheDocument();
    expect(screen.getByTestId("md")).toHaveTextContent("alpha answer");
    // The system row never reaches the transcript (Transcript.buildTurns would
    // drop it SILENTLY — the mapping makes the omission explicit).
    expect(screen.queryByText("Earlier turns were omitted.")).toBeNull();
    const remounted = useChatMock.mock.calls.at(-1)?.[0] as { messages?: unknown[] };
    expect(remounted.messages).toHaveLength(2);
  });

  test("a 404 (deleted elsewhere) clears the key and lands on the blank composer", async () => {
    window.sessionStorage.setItem(LAST_THREAD_STORAGE_KEY, "gone");
    route(/^\/api\/assistant\/threads\/gone$/, () =>
      jsonRes({ error: "Thread not found", code: "NOT_FOUND" }, 404),
    );

    renderWithClient(<AssistantPage />);

    expect(await screen.findByText(/I answer from your live inventory data/)).toBeInTheDocument();
    expect(window.sessionStorage.getItem(LAST_THREAD_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText(/Couldn’t load that conversation/)).toBeNull();
  });

  test("with no stored thread the page never fetches a detail route", async () => {
    renderWithClient(<AssistantPage />);
    await screen.findByText(/I answer from your live inventory data/);
    const urls = (global.fetch as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /^\/api\/assistant\/threads\/[^?]+$/.test(u))).toBe(false);
  });
});

describe("AssistantPage — switching threads (spec C5 skeleton + load error)", () => {
  test("a switch shows the transcript skeleton while the GET resolves", async () => {
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([listItem("t2", "Beta")])));
    const pending = deferred<ReturnType<typeof jsonRes>>();
    route(/^\/api\/assistant\/threads\/t2$/, () => pending.promise);

    renderWithClient(<AssistantPage />);
    await screen.findByText("Beta");

    fireEvent.click(screen.getByTestId("thread-item-t2"));
    expect(await screen.findByTestId("transcript-skeleton")).toBeInTheDocument();

    await act(async () => {
      pending.resolve(jsonRes(detail("t2", [dtoUser("m1", "beta ask"), dtoAsst("m2", "beta answer")])));
    });

    await waitFor(() => expect(screen.queryByTestId("transcript-skeleton")).toBeNull());
    expect(screen.getByText("beta ask")).toBeInTheDocument();
  });

  test("a load failure KEEPS the current thread mounted and offers retry", async () => {
    window.sessionStorage.setItem(LAST_THREAD_STORAGE_KEY, "t1");
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([listItem("t2", "Beta")])));
    route(/^\/api\/assistant\/threads\/t1$/, () =>
      jsonRes(detail("t1", [dtoUser("m1", "alpha ask"), dtoAsst("m2", "alpha answer")])),
    );
    let failNext = true;
    route(/^\/api\/assistant\/threads\/t2$/, () => {
      if (failNext) {
        failNext = false;
        return jsonRes({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
      }
      return jsonRes(detail("t2", [dtoUser("m3", "beta ask"), dtoAsst("m4", "beta answer")]));
    });

    renderWithClient(<AssistantPage />);
    await screen.findByText("alpha ask");

    fireEvent.click(screen.getByTestId("thread-item-t2"));

    expect(await screen.findByText(/Couldn’t load that conversation/)).toBeInTheDocument();
    // The CURRENT thread is still mounted — nothing was torn down.
    expect(screen.getByText("alpha ask")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("beta ask")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t load that conversation/)).toBeNull();
  });
});

describe("AssistantPage — busy-on-open banner + 2s poll (spec C5)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("opening a busy thread banners + disables the composer, then clears on poll", async () => {
    window.sessionStorage.setItem(LAST_THREAD_STORAGE_KEY, "t1");
    let running = true;
    route(/^\/api\/assistant\/threads\/t1$/, () =>
      running
        ? jsonRes(detail("t1", [dtoUser("m1", "alpha ask")], { status: "running" }))
        : jsonRes(detail("t1", [dtoUser("m1", "alpha ask"), dtoAsst("m2", "finished answer")])),
    );

    renderWithClient(<AssistantPage />);
    await flush();

    expect(screen.getByText(/a response is being generated in another session/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Message the assistant")).toBeDisabled();

    // The turn finishes elsewhere; the next 2s tick sees activeRequest === null.
    running = false;
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await flush();

    expect(screen.queryByText(/a response is being generated in another session/i)).toBeNull();
    expect(screen.getByTestId("md")).toHaveTextContent("finished answer");
    expect(screen.getByLabelText("Message the assistant")).not.toBeDisabled();
  });
});

describe("AssistantPage — deleting the OPEN thread resets to a blank composer", () => {
  test("delete of the open thread lands on the empty state", async () => {
    window.sessionStorage.setItem(LAST_THREAD_STORAGE_KEY, "t1");
    route(/^\/api\/assistant\/threads\?/, () => jsonRes(listPage([listItem("t1", "Alpha")])));
    route(/^\/api\/assistant\/threads\/t1$/, () =>
      jsonRes(detail("t1", [dtoUser("m1", "alpha ask"), dtoAsst("m2", "alpha answer")])),
    );
    route(/^\/api\/assistant\/threads\/t1$/, () => jsonRes({ deleted: true }), "DELETE");

    renderWithClient(<AssistantPage />);
    await screen.findByText("alpha ask");

    fireEvent.click(screen.getByTestId("thread-delete-t1"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete conversation" }));

    expect(await screen.findByText(/I answer from your live inventory data/)).toBeInTheDocument();
    expect(screen.queryByText("alpha ask")).toBeNull();
  });
});
