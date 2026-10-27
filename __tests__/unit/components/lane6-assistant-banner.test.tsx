/** @jest-environment jsdom */
//
// Lane 6 (L-ASSIST) — the banner split (plan Task 9; review M3). A model whose
// ANSWER is cut off at the output-token ceiling (finishReason "length") is a
// DIFFERENT failure from one that hit the step cap mid-work (finishReason
// "tool-calls"). They must map to distinct states with distinct, honest copy.

import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="md">{children}</div>,
}));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));
jest.mock("rehype-sanitize", () => ({ __esModule: true, default: () => undefined }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
// `ai` + `@ai-sdk/react` ship ESM-only; the hook module (imported for deriveTurnStatus)
// pulls them in at load time, so they are mocked here (matching lane4-assistant-ui).
jest.mock("ai", () => ({
  __esModule: true,
  isToolUIPart: (p: { type?: string }) => typeof p?.type === "string" && p.type.startsWith("tool-"),
  getToolName: (p: { type?: string }) => String(p?.type ?? "").replace(/^tool-/, ""),
  DefaultChatTransport: class {
    constructor(_o: unknown) {}
  },
}));
jest.mock("@ai-sdk/react", () => ({ useChat: jest.fn() }));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false, error: null, refreshToken: jest.fn() }),
}));

import { deriveTurnStatus } from "@/hooks/use-assistant-chat";
import { MessageTurn } from "@/components/assistant/message-turn";

type Msg = { id: string; role: "user" | "assistant"; parts: unknown[]; metadata?: unknown };
const userMsg = (text: string): Msg => ({ id: "u1", role: "user", parts: [{ type: "text", text }] });
const asstText = (text: string, metadata?: unknown): Msg => ({
  id: "a1",
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata,
});

const STEP_COPY = /Assistant reached its work limit before finishing/;
// A1 pack C7 — frozen copy, matched EXACTLY (string matchers, not regexes).
const LENGTH_COPY =
  "The answer ran out of room before it finished. Ask for fewer rows, or one part at a time.";
const TIMEOUT_COPY =
  "This took longer than the time limit, so the answer stopped. Asking for one part at a time usually helps.";
const REFUSED_COPY =
  "The AI model declined to answer this question. If it keeps declining ordinary inventory questions, an admin can review the model in AI Providers.";
// The failed-* sentence is unchanged by A1 — byte-identical.
const PROVIDER_FAILURE_COPY =
  "Assistant could not reach its AI provider. Try again. If this keeps happening, ask an admin to check AI Providers.";

describe("deriveTurnStatus: length vs step cap are distinct (review M3)", () => {
  const base = { isActive: true, chatStatus: "ready" as const, stopped: false };

  test("finishReason 'length' -> 'length-capped'", () => {
    expect(
      deriveTurnStatus({ ...base, assistant: asstText("partial", { finishReason: "length" }) as never }),
    ).toBe("length-capped");
  });

  test("finishReason 'tool-calls' -> 'step-capped'", () => {
    expect(
      deriveTurnStatus({ ...base, assistant: asstText("partial", { finishReason: "tool-calls" }) as never }),
    ).toBe("step-capped");
  });

  test("the two states are not the same", () => {
    const length = deriveTurnStatus({ ...base, assistant: asstText("x", { finishReason: "length" }) as never });
    const step = deriveTurnStatus({ ...base, assistant: asstText("x", { finishReason: "tool-calls" }) as never });
    expect(length).not.toBe(step);
  });
});

describe("MessageTurn: length-capped banner copy is distinct from step-capped", () => {
  const noop = () => undefined;

  test("length-capped shows the cut-off copy, NOT the work-limit copy", () => {
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={asstText("half an answer") as never} status="length-capped" onRetry={noop} />
      </ul>,
    );
    expect(screen.getByText(LENGTH_COPY)).toBeInTheDocument();
    expect(screen.queryByText(STEP_COPY)).toBeNull();
    // The partial answer is preserved, not discarded.
    expect(screen.getByTestId("md")).toHaveTextContent("half an answer");
  });

  test("step-capped shows the work-limit copy, NOT the cut-off copy", () => {
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={asstText("some") as never} status="step-capped" onRetry={noop} />
      </ul>,
    );
    expect(screen.getByText(STEP_COPY)).toBeInTheDocument();
    expect(screen.queryByText(LENGTH_COPY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A1 pack C7 — timed-out / refused / length-capped copy. Banners carry NO live
// role (the transcript's milestone region is the single announcer); the
// FailureStrip keeps its existing role="alert", for timed-out as for failed-*.
// ---------------------------------------------------------------------------

/** `a` comes BEFORE `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("MessageTurn: A1 C7 frozen copy", () => {
  const noop = () => undefined;

  test("timed-out: the FailureStrip layout (role=alert + Retry) with the time-limit sentence", () => {
    const onRetry = jest.fn();
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={asstText("half an answer") as never} status="timed-out" onRetry={onRetry} />
      </ul>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(TIMEOUT_COPY)).toBeInTheDocument();
    // Its OWN sentence — never the provider-unreachable one.
    expect(screen.queryByText(PROVIDER_FAILURE_COPY)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The partial answer is preserved ABOVE the strip.
    const md = screen.getByTestId("md");
    expect(md).toHaveTextContent("half an answer");
    expect(precedes(md, alert)).toBe(true);
  });

  test("timed-out with NO content (live): the assistant body still shows the strip", () => {
    const contentless = { id: "a1", role: "assistant", parts: [], metadata: { errorCode: "PROVIDER_TIMEOUT" } };
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={contentless as never} status="timed-out" onRetry={noop} />
      </ul>,
    );
    expect(within(screen.getByRole("alert")).getByText(TIMEOUT_COPY)).toBeInTheDocument();
    expect(screen.queryByTestId("md")).toBeNull();
  });

  test("timed-out with no assistant message at all: showAssistant is still true (C6)", () => {
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} status="timed-out" onRetry={noop} />
      </ul>,
    );
    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByText(TIMEOUT_COPY)).toBeInTheDocument();
  });

  test.each(["failed-before-content", "failed-after-content"] as const)(
    "%s: the provider-unreachable sentence is byte-identical, with Retry",
    (status) => {
      const onRetry = jest.fn();
      render(
        <ul>
          <MessageTurn
            user={userMsg("q") as never}
            assistant={status === "failed-after-content" ? (asstText("partial") as never) : undefined}
            status={status}
            onRetry={onRetry}
          />
        </ul>,
      );
      const alert = screen.getByRole("alert");
      const sentence = within(alert).getByText(PROVIDER_FAILURE_COPY);
      expect(sentence.textContent).toBe(PROVIDER_FAILURE_COPY);
      expect(screen.queryByText(TIMEOUT_COPY)).toBeNull();
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    },
  );

  test("length-capped: the AmberBanner carries the C7 sentence exactly, partial text above, no live role", () => {
    const { container } = render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={asstText("half an answer") as never} status="length-capped" onRetry={noop} />
      </ul>,
    );
    const banner = screen.getByText(LENGTH_COPY);
    expect(banner.textContent).toBe(LENGTH_COPY);
    expect(precedes(screen.getByTestId("md"), banner)).toBe(true);
    expect(banner).not.toHaveAttribute("role");
    expect(container.querySelector("[role], [aria-live]")).toBeNull();
    // The pre-A1 sentence is gone.
    expect(screen.queryByText(/Ask for a shorter summary or a narrower slice/)).toBeNull();
  });

  test("refused: the AmberBanner carries the C7 sentence exactly, partial text above, no live role", () => {
    const { container } = render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={asstText("A partial line.") as never} status="refused" onRetry={noop} />
      </ul>,
    );
    const banner = screen.getByText(REFUSED_COPY);
    expect(banner.textContent).toBe(REFUSED_COPY);
    expect(precedes(screen.getByTestId("md"), banner)).toBe(true);
    expect(banner).not.toHaveAttribute("role");
    expect(container.querySelector("[role], [aria-live]")).toBeNull();
    // A refusal is not a failure: no strip, no Retry.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("refused with an empty answer: the banner still shows (R4-6b — never a blank 'completed')", () => {
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={asstText("") as never} status="refused" onRetry={noop} />
      </ul>,
    );
    expect(screen.getByText(REFUSED_COPY)).toBeInTheDocument();
  });

  test("refused with no assistant message at all: showAssistant is still true (C6)", () => {
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} status="refused" onRetry={noop} />
      </ul>,
    );
    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(screen.getByText(REFUSED_COPY)).toBeInTheDocument();
  });

  test.each(["step-capped", "truncated", "stopped"] as const)(
    "%s: the banner is unchanged and carries no live role",
    (status) => {
      const { container } = render(
        <ul>
          <MessageTurn user={userMsg("q") as never} assistant={asstText("some") as never} status={status} onRetry={noop} />
        </ul>,
      );
      expect(container.querySelector("[role], [aria-live]")).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// A1 pack C6 (FR1, A1-OCC-2) — Retry on the LAST turn only. `regenerate()` always
// re-runs the latest turn, so the transcript hands `onRetry` to the last turn
// alone; an OLDER failed / timed-out turn shows its sentence statically — same
// sentence, same styling, no Retry button and no role="alert" (a historic strip
// must not re-announce).
// ---------------------------------------------------------------------------

describe("MessageTurn: the FailureStrip without onRetry is static (A1 C6 FR1)", () => {
  const cases = [
    { status: "timed-out" as const, copy: TIMEOUT_COPY, assistant: asstText("half an answer") },
    { status: "failed-after-content" as const, copy: PROVIDER_FAILURE_COPY, assistant: asstText("partial") },
    { status: "failed-before-content" as const, copy: PROVIDER_FAILURE_COPY, assistant: undefined },
  ];

  test.each(cases)("$status with no onRetry: the sentence, no Retry, no live role", ({ status, copy, assistant }) => {
    const { container } = render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={assistant as never} status={status} />
      </ul>,
    );
    const sentence = screen.getByText(copy);
    expect(sentence.textContent).toBe(copy);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("[role], [aria-live]")).toBeNull();
  });

  test.each(cases)("$status: the static strip keeps the strip's styling exactly", ({ status, copy, assistant }) => {
    const live = render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={assistant as never} status={status} onRetry={jest.fn()} />
      </ul>,
    );
    const liveSentence = within(live.getByRole("alert")).getByText(copy);
    const liveClasses = { sentence: liveSentence.className, strip: liveSentence.parentElement!.className };
    live.unmount();

    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={assistant as never} status={status} />
      </ul>,
    );
    const staticSentence = screen.getByText(copy);
    expect(staticSentence.className).toBe(liveClasses.sentence);
    expect(staticSentence.parentElement!.className).toBe(liveClasses.strip);
  });

  test.each(cases)("$status WITH onRetry (the last turn): role=alert + Retry calls it", ({ status, copy, assistant }) => {
    const onRetry = jest.fn();
    render(
      <ul>
        <MessageTurn user={userMsg("q") as never} assistant={assistant as never} status={status} onRetry={onRetry} />
      </ul>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(copy)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
