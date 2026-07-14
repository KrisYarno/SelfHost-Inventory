/** @jest-environment jsdom */
//
// Lane 6 (L-ASSIST) — the banner split (plan Task 9; review M3). A model whose
// ANSWER is cut off at the output-token ceiling (finishReason "length") is a
// DIFFERENT failure from one that hit the step cap mid-work (finishReason
// "tool-calls"). They must map to distinct states with distinct, honest copy.

import * as React from "react";
import { render, screen } from "@testing-library/react";

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
const LENGTH_COPY = /The answer was cut off\. Ask for a shorter summary or a narrower slice\./;

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
