/** @jest-environment jsdom */
//
// Task 3.2 — the two UI surfaces of spec C9.
//
//   1. `ReportThreadAction` (components/assistant/report-dialog.tsx) — the
//      per-thread action in the sidebar row and its CONSENT dialog. The whole
//      privacy design rests on this dialog telling the truth: the FULL
//      conversation, INCLUDING tool outputs, crosses to the admin, and nothing
//      crosses without this click. The action is also asserted THROUGH
//      `ThreadSidebar`, because an action that exists only in isolation is not
//      an action a user has.
//   2. `EvalSection` (components/admin/usage/eval-section.tsx) — the C9 section
//      mounted in the 3.1 anchor: latest scored run, run history spanning both
//      sources, per-row export links. It renders user-report METADATA only: the
//      transcript itself crosses by the deliberate export download, never as
//      page text an admin reads by accident.

import * as React from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastSuccessMock = jest.fn();
const toastErrorMock = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false, error: null, refreshToken: jest.fn() }),
  withCSRFHeaders: (headers: Record<string, string>, token: string | null) => ({
    ...headers,
    "x-csrf-token": token ?? "",
  }),
}));

// The hook module keeps its real helpers; only the query is stubbed (the 3.1
// admin-usage.test.tsx idiom).
let mockEvalQuery: any;
jest.mock("@/hooks/use-assistant-eval", () => {
  const actual = jest.requireActual("@/hooks/use-assistant-eval");
  return {
    __esModule: true,
    ...actual,
    useAssistantEvalReports: () => mockEvalQuery,
  };
});

import { ThreadSidebar } from "@/components/assistant/thread-sidebar";
import {
  ReportThreadAction,
  REPORT_ACTION_LABEL,
  REPORT_CONSENT_HEADLINE,
  REPORT_CONSENT_BODY,
} from "@/components/assistant/report-dialog";
import {
  EvalSection,
  EVAL_SECTION_HEADING,
  EVAL_EMPTY_REASON,
  EVAL_NOT_APPLICABLE_LABEL,
  EVAL_USER_REPORT_LABEL,
  EVAL_REPORT_PRIVACY_NOTE,
} from "@/components/admin/usage/eval-section";
import { evalExportHref, type AssistantEvalResponse } from "@/hooks/use-assistant-eval";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// fetch router (thread-sidebar.test.tsx idiom)
// ---------------------------------------------------------------------------

type Handler = (url: string, init?: RequestInit) => unknown;
let routes: Array<{ match: RegExp; method?: string; handler: Handler }> = [];
let requests: Array<{ url: string; init?: RequestInit }> = [];

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
    requests.push({ url, init });
    for (const r of routes) {
      if (r.match.test(url) && (!r.method || r.method === method)) return r.handler(url, init);
    }
    throw new Error(`unrouted fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWithClient(ui: React.ReactElement) {
  return render(<QueryClientProvider client={newClient()}>{ui}</QueryClientProvider>);
}

const listPage = (items: unknown[]) => ({ items, limit: 20, offset: 0, nextOffset: null });
const listItem = (id: string, title: string | null) => ({
  id,
  title,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messageCount: 2,
});

beforeEach(() => {
  routes = [];
  requests = [];
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  installFetch();
});

// ===========================================================================
// 1. ReportThreadAction — consent
// ===========================================================================

describe("ReportThreadAction — the consent dialog (spec C9)", () => {
  const props = { threadId: "t1", title: "Stock questions" };

  test("the dialog says WHAT crosses: the full conversation INCLUDING tool outputs", async () => {
    renderWithClient(<ReportThreadAction {...props} />);

    fireEvent.click(screen.getByTestId("thread-report-t1"));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(REPORT_CONSENT_HEADLINE)).toBeInTheDocument();
    // Not "some content" and not "an excerpt" — the words a user needs to consent.
    expect(REPORT_CONSENT_BODY).toMatch(/tool output/i);
    expect(REPORT_CONSENT_BODY).toMatch(/entire|whole|full/i);
    expect(screen.getByText(REPORT_CONSENT_BODY)).toBeInTheDocument();
  });

  test("the trigger names the conversation and is labelled for assistive tech", () => {
    renderWithClient(<ReportThreadAction {...props} />);

    const trigger = screen.getByTestId("thread-report-t1");
    expect(trigger).toHaveAttribute("aria-label", `${REPORT_ACTION_LABEL}: Stock questions`);
  });

  test("opening the dialog sends NOTHING; only the confirm posts", async () => {
    route(/\/report$/, () => jsonRes({ reported: true, id: 5 }), "POST");
    renderWithClient(<ReportThreadAction {...props} />);

    fireEvent.click(screen.getByTestId("thread-report-t1"));
    await screen.findByRole("alertdialog");
    expect(requests).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: REPORT_ACTION_LABEL }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].url).toBe("/api/assistant/threads/t1/report");
    expect(requests[0].init?.method).toBe("POST");
    expect((requests[0].init?.headers as any)["x-csrf-token"]).toBe("csrf-token");
  });

  test("cancelling sends nothing at all", async () => {
    renderWithClient(<ReportThreadAction {...props} />);

    fireEvent.click(screen.getByTestId("thread-report-t1"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toHaveLength(0);
  });

  test("the reporter's optional note is the ONLY body the client sends", async () => {
    route(/\/report$/, () => jsonRes({ reported: true, id: 5 }), "POST");
    renderWithClient(<ReportThreadAction {...props} />);

    fireEvent.click(screen.getByTestId("thread-report-t1"));
    fireEvent.change(await screen.findByTestId("report-note-t1"), {
      target: { value: "the stock number looks wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: REPORT_ACTION_LABEL }));

    await waitFor(() => expect(requests).toHaveLength(1));
    // The server reads the transcript from ITS OWN store — the client never
    // uploads conversation text.
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      reporterNote: "the stock number looks wrong",
    });
  });

  test("a truncated report says so — the disclosure reaches the reporter too", async () => {
    route(
      /\/report$/,
      () => jsonRes({ reported: true, id: 5, truncation: { applied: true, omittedToolOutputCount: 3 } }),
      "POST",
    );
    renderWithClient(<ReportThreadAction {...props} />);

    fireEvent.click(screen.getByTestId("thread-report-t1"));
    fireEvent.click(await screen.findByRole("button", { name: REPORT_ACTION_LABEL }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    expect(String(toastSuccessMock.mock.calls[0][0])).toMatch(/3/);
  });

  test("a refusal surfaces the SERVER's reason (429 / 413), never a generic success", async () => {
    route(
      /\/report$/,
      () => jsonRes({ error: "Too many requests", code: "RATE_LIMITED" }, 429),
      "POST",
    );
    renderWithClient(<ReportThreadAction {...props} />);

    fireEvent.click(screen.getByTestId("thread-report-t1"));
    fireEvent.click(await screen.findByRole("button", { name: REPORT_ACTION_LABEL }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(String(toastErrorMock.mock.calls[0][0])).toMatch(/Too many requests/);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});

describe("ReportThreadAction — inside the sidebar row (spec C9 placement)", () => {
  test("every thread row carries its own report action", async () => {
    route(/^\/api\/assistant\/threads\?/, () =>
      jsonRes(listPage([listItem("t1", "Alpha"), listItem("t2", null)])),
    );

    renderWithClient(
      <ThreadSidebar
        activeThreadId={null}
        streamingThreadId={null}
        onSelectThread={jest.fn()}
        onNewThread={jest.fn()}
        onThreadDeleted={jest.fn()}
      />,
    );

    await screen.findByText("Alpha");
    expect(screen.getByTestId("thread-report-t1")).toBeInTheDocument();
    expect(screen.getByTestId("thread-report-t2")).toHaveAttribute(
      "aria-label",
      `${REPORT_ACTION_LABEL}: Untitled`,
    );
    // The delete affordance 2.2 shipped is untouched.
    expect(screen.getByTestId("thread-delete-t1")).toBeInTheDocument();
  });
});

// ===========================================================================
// 2. EvalSection
// ===========================================================================

const evalSummary = (over: Partial<AssistantEvalResponse["history"][number]> = {}) => ({
  id: 1,
  runAt: "2026-08-11T09:00:00.000Z",
  environment: "dev",
  model: "claude-opus-5",
  corpusRev: "corpus-2026-08-11",
  source: "eval-run" as const,
  createdAt: "2026-08-11T09:00:00.000Z",
  ...over,
});

const evalReport = (turns: unknown[]) => ({
  runAt: "2026-08-11T09:00:00.000Z",
  environment: "dev",
  model: "claude-opus-5",
  corpusRev: "corpus-2026-08-11",
  turns,
});

const turn = (over: Record<string, unknown> = {}) => ({
  conversation: "inv-prompts-1",
  turn: 1,
  prompt: "what is low on stock?",
  verdict: "pass",
  notes: "cited the real thresholds",
  toolCalls: ["get_low_stock"],
  answerExcerpt: "Three products are below their reorder point",
  ...over,
});

describe("EvalSection — states", () => {
  test("loading renders a skeleton, never an empty scoreboard", () => {
    mockEvalQuery = { data: undefined, isLoading: true, isError: false, refetch: jest.fn() };

    render(<EvalSection />);

    expect(screen.getByTestId("eval-loading")).toBeInTheDocument();
  });

  test("an error is spoken aloud with a retry, never rendered as 'no reports'", () => {
    const refetch = jest.fn();
    mockEvalQuery = { data: undefined, isLoading: false, isError: true, refetch };

    render(<EvalSection />);

    expect(screen.queryByText(EVAL_EMPTY_REASON)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  test("no reports yet => a NAMED reason, not a zeroed table", () => {
    mockEvalQuery = {
      data: { latest: null, history: [], historyNote: "the 50 most recent reports" },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };

    render(<EvalSection />);

    expect(screen.getByText(EVAL_SECTION_HEADING)).toBeInTheDocument();
    expect(screen.getByText(EVAL_EMPTY_REASON)).toBeInTheDocument();
  });
});

describe("EvalSection — latest run + history", () => {
  beforeEach(() => {
    mockEvalQuery = {
      data: {
        latest: {
          ...evalSummary({ id: 9 }),
          report: evalReport([
            turn(),
            turn({ turn: 2, verdict: "fail", notes: "invented a supplier", toolCalls: [] }),
          ]),
        },
        history: [
          evalSummary({
            id: 10,
            source: "user-report",
            model: null,
            corpusRev: null,
            environment: "production",
            runAt: "2026-08-11T10:00:00.000Z",
          }),
          evalSummary({ id: 9 }),
        ],
        historyNote: "the 50 most recent reports",
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
  });

  test("the latest scored run shows its model, corpus revision and per-turn verdicts", () => {
    render(<EvalSection />);

    // Scoped to the latest block: the history table lists the SAME run below, so a
    // bare getByText would match twice and prove nothing about placement.
    const latest = screen.getByTestId("eval-latest");
    expect(within(latest).getByText("claude-opus-5")).toBeInTheDocument();
    expect(within(latest).getByText("corpus-2026-08-11")).toBeInTheDocument();
    expect(within(latest).getByText("pass")).toBeInTheDocument();
    expect(within(latest).getByText("fail")).toBeInTheDocument();
    expect(within(latest).getByText("invented a supplier")).toBeInTheDocument();
  });

  // W3S-2: the bounded answer being scored must be INSPECTABLE — the excerpt is the
  // whole point of the <=500-char upload bound (spec C9), and a verdict without the
  // judged answer is unreviewable. Rendered as a text node inside the eval mount.
  test("W3S-2: the answer excerpt renders inside the eval section", () => {
    render(<EvalSection />);
    const cells = screen.getAllByTestId("eval-answer-excerpt");
    expect(cells.length).toBeGreaterThan(0);
    expect(screen.getAllByText("Three products are below their reorder point").length).toBeGreaterThan(0);
  });

  test("every history row — BOTH sources — carries an export link to its own row", () => {
    render(<EvalSection />);

    const rowUserReport = screen.getByTestId("eval-history-10");
    const rowEvalRun = screen.getByTestId("eval-history-9");
    expect(within(rowUserReport).getByRole("link")).toHaveAttribute("href", evalExportHref(10));
    expect(within(rowEvalRun).getByRole("link")).toHaveAttribute("href", evalExportHref(9));
    expect(evalExportHref(10)).toBe("/api/admin/assistant-eval/10/export");
  });

  test("a user report's NULL model/corpusRev renders a named reason, never a fake value", () => {
    render(<EvalSection />);

    const row = screen.getByTestId("eval-history-10");
    expect(within(row).getByText("user-report")).toBeInTheDocument();
    // Micro round 2026-08-11: the generic label under-explained — Kris (the first
    // real reporter) read it as breakage. A user report's absence is INHERENT to
    // the row type, and the cell now says so without needing the Source column.
    expect(within(row).getAllByText(EVAL_USER_REPORT_LABEL).length).toBeGreaterThanOrEqual(1);
    expect(within(row).queryByText(EVAL_NOT_APPLICABLE_LABEL)).toBeNull();
    expect(within(row).queryByText("claude-opus-5")).toBeNull();
  });

  test("no reported CONVERSATION text is rendered inline — the export is the only path", () => {
    render(<EvalSection />);

    const row = screen.getByTestId("eval-history-10");
    // Metadata + an export link, nothing else: the row must not become a place an
    // admin reads someone's chat by scrolling past it.
    expect(within(row).queryByTestId("eval-report-payload")).toBeNull();
    expect(screen.getByText(EVAL_REPORT_PRIVACY_NOTE)).toBeInTheDocument();
  });

  test("the history bound is disclosed with the list it bounds", () => {
    render(<EvalSection />);

    expect(screen.getByText("the 50 most recent reports")).toBeInTheDocument();
  });
});
