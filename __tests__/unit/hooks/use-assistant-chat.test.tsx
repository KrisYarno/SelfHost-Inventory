/** @jest-environment jsdom */
//
// W2 Task 2.1 — the client hook flip (spec C10 + C2/C3; contract pack T7).
//
// ENV NOTE: `ai` and `@ai-sdk/react` are ESM-only and next/jest cannot transform
// them, so both are mocked here (matching lane4-assistant-ui). The
// `DefaultChatTransport` stub CAPTURES its constructor options: the C2 envelope
// that `prepareSendMessagesRequest` builds is the wire contract the launch gate
// replays (2.4a), so it has to be assertable without a network.
//
// The four things this file exists to hold still:
//   1. the envelope mapping ({ messages, id, trigger, messageId } -> C2);
//   2. `chatKey` — STABLE across threadId arrival (a key change mid-stream
//      recreates the Chat and destroys the first in-flight response), CHANGED on
//      openThread/newThread;
//   3. the threadId ref fed from the FIRST metadata carrier + the sessionStorage
//      last-open key (written here, READ by the page — 2.2);
//   4. THREAD_BUSY classification and the persisted-metadata turn statuses.

import { act, renderHook } from "@testing-library/react";

const mockTransportOptions: Array<Record<string, unknown>> = [];
jest.mock("ai", () => ({
  __esModule: true,
  isToolUIPart: (p: { type?: string }) => typeof p?.type === "string" && p.type.startsWith("tool-"),
  getToolName: (p: { type?: string }) => String(p?.type ?? "").replace(/^tool-/, ""),
  DefaultChatTransport: class {
    constructor(options: Record<string, unknown>) {
      mockTransportOptions.push(options);
    }
  },
}));

// A controllable `useChat`: the test mutates `mockChat` and re-renders to play
// the SDK's part (stream chunks arriving as new message arrays).
const mockChat: { messages: unknown[]; status: string; error: Error | undefined } = {
  messages: [],
  status: "ready",
  error: undefined,
};
const mockUseChatOptions: Array<{ id?: string; messages?: unknown[] }> = [];
const mockSendMessage = jest.fn();
const mockStop = jest.fn();
const mockRegenerate = jest.fn();
const mockClearError = jest.fn();
jest.mock("@ai-sdk/react", () => ({
  useChat: (options: { id?: string; messages?: unknown[] }) => {
    mockUseChatOptions.push(options);
    return {
      messages: mockChat.messages,
      status: mockChat.status,
      error: mockChat.error,
      sendMessage: mockSendMessage,
      stop: mockStop,
      regenerate: mockRegenerate,
      clearError: mockClearError,
    };
  },
}));

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false, error: null, refreshToken: jest.fn() }),
}));

import {
  useAssistantChat,
  deriveTurnStatus,
  classifyChatError,
  LAST_THREAD_STORAGE_KEY,
} from "@/hooks/use-assistant-chat";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

type Msg = { id: string; role: "user" | "assistant"; parts: unknown[]; metadata?: unknown };
const userMsg = (text: string, id = "u1"): Msg => ({ id, role: "user", parts: [{ type: "text", text }] });
const asstMsg = (text: string, id = "a1", metadata?: unknown): Msg => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata,
});

/** The transport is memoized ONCE per mount — a second construction would mean a
 *  rebuilt transport (and a stale captured threadId). */
function transportOptions() {
  expect(mockTransportOptions).toHaveLength(1);
  return mockTransportOptions[0] as {
    api?: string;
    body?: unknown;
    headers?: () => Record<string, string>;
    prepareSendMessagesRequest?: (o: Record<string, unknown>) => { body: Record<string, unknown> };
  };
}

/** Call `prepareSendMessagesRequest` with the SDK's real argument shape
 *  (ai/dist/index.d.ts PrepareSendMessagesRequest) and return the body it emits. */
function prepareBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const prepare = transportOptions().prepareSendMessagesRequest;
  if (!prepare) throw new Error("transport carries no prepareSendMessagesRequest");
  return prepare({
    api: "/api/assistant",
    id: "chat-key",
    messages: [userMsg("older", "u0"), userMsg("newest", "u1")],
    body: undefined,
    headers: {},
    credentials: undefined,
    requestMetadata: undefined,
    trigger: "submit-message",
    messageId: undefined,
    ...over,
  }).body;
}

const lastChatKey = (): string | undefined => mockUseChatOptions[mockUseChatOptions.length - 1]?.id;

beforeEach(() => {
  mockTransportOptions.length = 0;
  mockUseChatOptions.length = 0;
  mockChat.messages = [];
  mockChat.status = "ready";
  mockChat.error = undefined;
  jest.clearAllMocks();
  window.sessionStorage.clear();
  // The U1 readiness probe fails silently — `configured` stays null and no state
  // update escapes these synchronous assertions.
  global.fetch = jest.fn().mockRejectedValue(new Error("probe disabled")) as unknown as typeof fetch;
});

// ---------------------------------------------------------------------------
// The C2 envelope (spec C2; pack T0/T7)
// ---------------------------------------------------------------------------

describe("transport envelope (C2)", () => {
  test("the transport is built ONCE: assistant api, CSRF header thunk, NO body payload", () => {
    renderHook(() => useAssistantChat());
    const opts = transportOptions();
    expect(opts.api).toBe("/api/assistant");
    expect(opts.headers?.()).toEqual({ "x-csrf-token": "csrf-token" });
    // The old client-minted `conversationId` envelope field is DELETED, not moved.
    expect(opts.body).toBeUndefined();
  });

  test("maps { messages, trigger, messageId } to { threadId, message: LAST, trigger, messageId }", () => {
    renderHook(() => useAssistantChat());
    const body = prepareBody({ messageId: "u1" });
    expect(body).toEqual({
      threadId: null, // no thread yet — the server creates one
      message: userMsg("newest", "u1"),
      trigger: "submit-message",
      messageId: "u1",
    });
    // The client NEVER uploads history.
    expect(body.messages).toBeUndefined();
  });

  test("regenerate-message passes through as the trigger", () => {
    renderHook(() => useAssistantChat());
    expect(prepareBody({ trigger: "regenerate-message" }).trigger).toBe("regenerate-message");
  });

  test("threadId comes from the REF — it is live the moment start-metadata arrives", () => {
    const { rerender } = renderHook(() => useAssistantChat());
    expect(prepareBody().threadId).toBeNull();

    // The route's "start" carrier: messageMetadata { threadId }.
    mockChat.messages = [userMsg("hi"), asstMsg("", "a1", { threadId: "cthread0001" })];
    mockChat.status = "streaming";
    act(() => rerender());

    expect(prepareBody().threadId).toBe("cthread0001");
  });
});

// ---------------------------------------------------------------------------
// chatKey (spec C10) — the reason the server threadId is NOT the useChat id
// ---------------------------------------------------------------------------

describe("chatKey (C10)", () => {
  test("STABLE across threadId arrival — the in-flight Chat is never recreated", () => {
    const { result, rerender } = renderHook(() => useAssistantChat());
    const keyBefore = lastChatKey();
    expect(keyBefore).toBeTruthy();

    mockChat.messages = [userMsg("hi"), asstMsg("partial", "a1", { threadId: "cthread0001" })];
    mockChat.status = "streaming";
    act(() => rerender());

    expect(lastChatKey()).toBe(keyBefore);
    expect(result.current.threadId).toBe("cthread0001");
  });

  test("the FIRST metadata carrier wins — a later carrier never re-points the thread", () => {
    const { result, rerender } = renderHook(() => useAssistantChat());
    mockChat.messages = [userMsg("hi"), asstMsg("a", "a1", { threadId: "cthread0001" })];
    act(() => rerender());
    mockChat.messages = [
      userMsg("hi"),
      asstMsg("a", "a1", { threadId: "cthread0001" }),
      asstMsg("b", "a2", { threadId: "cthreadOTHER" }),
    ];
    act(() => rerender());
    expect(result.current.threadId).toBe("cthread0001");
  });

  test("openThread remounts with a NEW key and the loaded messages, and points the ref", () => {
    const { result } = renderHook(() => useAssistantChat());
    const keyBefore = lastChatKey();
    const loaded = [userMsg("older question", "u9"), asstMsg("older answer", "a9")];

    act(() => result.current.openThread("cthread0042", loaded as never));

    expect(lastChatKey()).not.toBe(keyBefore);
    expect(mockUseChatOptions[mockUseChatOptions.length - 1]?.messages).toEqual(loaded);
    expect(result.current.threadId).toBe("cthread0042");
    expect(prepareBody().threadId).toBe("cthread0042");
  });

  test("newThread remounts blank: new key, no messages, null threadId", () => {
    const { result } = renderHook(() => useAssistantChat());
    act(() => result.current.openThread("cthread0042", [userMsg("q", "u9")] as never));
    const keyAfterOpen = lastChatKey();

    act(() => result.current.newThread());

    expect(lastChatKey()).not.toBe(keyAfterOpen);
    expect(mockUseChatOptions[mockUseChatOptions.length - 1]?.messages).toEqual([]);
    expect(result.current.threadId).toBeNull();
    expect(prepareBody().threadId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessionStorage last-open (pack T7) — written HERE, read by the page (2.2)
// ---------------------------------------------------------------------------

describe("sessionStorage last-open key", () => {
  test("the key is exactly the contracted one", () => {
    expect(LAST_THREAD_STORAGE_KEY).toBe("assistant:lastThreadId");
  });

  test("a threadId arriving from metadata is persisted", () => {
    const { rerender } = renderHook(() => useAssistantChat());
    expect(window.sessionStorage.getItem(LAST_THREAD_STORAGE_KEY)).toBeNull();

    mockChat.messages = [userMsg("hi"), asstMsg("", "a1", { threadId: "cthread0001" })];
    act(() => rerender());

    expect(window.sessionStorage.getItem(LAST_THREAD_STORAGE_KEY)).toBe("cthread0001");
  });

  test("openThread persists; newThread CLEARS", () => {
    const { result } = renderHook(() => useAssistantChat());
    act(() => result.current.openThread("cthread0042", [] as never));
    expect(window.sessionStorage.getItem(LAST_THREAD_STORAGE_KEY)).toBe("cthread0042");

    act(() => result.current.newThread());
    expect(window.sessionStorage.getItem(LAST_THREAD_STORAGE_KEY)).toBeNull();
  });

  test("the hook never READS the key — resume is the page's fetch (2.2)", () => {
    window.sessionStorage.setItem(LAST_THREAD_STORAGE_KEY, "cthreadSTALE");
    const { result } = renderHook(() => useAssistantChat());
    expect(result.current.threadId).toBeNull();
    expect(prepareBody().threadId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THREAD_BUSY (spec C5; pack error behavior — clients branch on `code`)
// ---------------------------------------------------------------------------

describe("THREAD_BUSY classification", () => {
  const busyBody = JSON.stringify({
    error: "A response is already streaming in this thread",
    code: "THREAD_BUSY",
  });

  test("a 409 THREAD_BUSY body classifies as busy", () => {
    expect(classifyChatError(new Error(busyBody))?.kind).toBe("busy");
  });

  test("the hook exposes it as busyInAnotherSession", () => {
    mockChat.error = new Error(busyBody);
    mockChat.status = "error";
    const { result } = renderHook(() => useAssistantChat());
    expect(result.current.busyInAnotherSession).toBe(true);
  });

  test("no error / other errors are NOT busy", () => {
    const { result, rerender } = renderHook(() => useAssistantChat());
    expect(result.current.busyInAnotherSession).toBe(false);
    mockChat.error = new Error("PROVIDER_ERROR");
    act(() => rerender());
    expect(result.current.busyInAnotherSession).toBe(false);
  });

  test("classification reads `code`, NEVER the message prose", () => {
    // Same human sentence, no code field: must not be mistaken for busy.
    const proseOnly = new Error("A response is already streaming in this thread");
    expect(classifyChatError(proseOnly)?.kind).toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// deriveTurnStatus — persisted metadata (pack T4 precedence). SIGNATURE UNCHANGED:
// the same four-key argument the transcript has always passed.
// ---------------------------------------------------------------------------

describe("deriveTurnStatus on persisted turns", () => {
  const resumed = { isActive: false, chatStatus: "ready" as const, stopped: false };

  test("metadata.aborted -> stopped (a reloaded stopped turn is not 'completed')", () => {
    expect(
      deriveTurnStatus({ ...resumed, assistant: asstMsg("partial", "a1", { aborted: true }) as never }),
    ).toBe("stopped");
  });

  test("metadata.errorCode WITH content -> failed-after-content", () => {
    expect(
      deriveTurnStatus({
        ...resumed,
        assistant: asstMsg("partial", "a1", { errorCode: "PROVIDER_ERROR" }) as never,
      }),
    ).toBe("failed-after-content");
  });

  test("a plain ok turn still reads completed (positive control)", () => {
    expect(
      deriveTurnStatus({ ...resumed, assistant: asstMsg("done", "a1", { finishReason: "stop" }) as never }),
    ).toBe("completed");
  });

  test("finish-reason caps survive the metadata addition", () => {
    expect(
      deriveTurnStatus({ ...resumed, assistant: asstMsg("x", "a1", { finishReason: "tool-calls" }) as never }),
    ).toBe("step-capped");
    expect(
      deriveTurnStatus({ ...resumed, assistant: asstMsg("x", "a1", { finishReason: "length" }) as never }),
    ).toBe("length-capped");
  });

  test("the live path is untouched: active + streaming still streams", () => {
    expect(
      deriveTurnStatus({
        assistant: asstMsg("partial") as never,
        isActive: true,
        chatStatus: "streaming",
        stopped: false,
      }),
    ).toBe("streaming");
  });
});

// ---------------------------------------------------------------------------
// The returned surface (pack T7) — 2.2 consumes exactly this.
// ---------------------------------------------------------------------------

describe("hook interface (T7)", () => {
  test("returns today's shape PLUS threadId/openThread/newThread/busyInAnotherSession", () => {
    const { result } = renderHook(() => useAssistantChat());
    expect(Object.keys(result.current).sort()).toEqual(
      [
        "busyInAnotherSession",
        "configured",
        "csrfReady",
        "error",
        "input",
        "messages",
        "newThread",
        "openThread",
        "retry",
        "sendPrompt",
        "setInput",
        "status",
        "stop",
        "stoppedIds",
        "threadId",
      ].sort(),
    );
  });

  test("sendPrompt still guards on CSRF readiness and clears the composer", () => {
    const { result } = renderHook(() => useAssistantChat());
    act(() => result.current.setInput("what is low?"));
    act(() => result.current.sendPrompt("what is low?"));
    expect(mockSendMessage).toHaveBeenCalledWith({ text: "what is low?" });
    expect(result.current.input).toBe("");
  });
});
