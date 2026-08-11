"use client";

/**
 * hooks/use-assistant-chat.ts — the client transport + state machine for the
 * assistant (spec §11 + §12 D-B4/D-B6/D-B7; multi-user spec C2/C3/C10).
 *
 *   - wraps `useChat` (@ai-sdk/react) over a `DefaultChatTransport` that attaches
 *     `x-csrf-token` on EVERY request (send is disabled until the token is ready)
 *     and maps the SDK's request to the C2 envelope — `{ threadId, message, trigger,
 *     messageId }`, the single NEW message only: history is server-canonical and the
 *     client never uploads it;
 *   - owns `chatKey`, the `useChat` id (C10). It is NEVER the server thread id:
 *     `useChat` recreates its Chat instance whenever `id` changes, so keying by a
 *     thread id that arrives mid-response would destroy that first stream. The
 *     thread id lives in a REF the transport reads (the transport is memoized once,
 *     so a captured value would go stale) and is mirrored into state for the UI;
 *   - tracks user-initiated Stop so a stopped turn preserves its partial content;
 *   - exposes `retry` (regenerate the last user turn WITHOUT duplicating it) and
 *     `classifyChatError` so the page can fork the unconfigured / rate-limited /
 *     busy-in-another-session / provider-unavailable states.
 *
 * `deriveTurnStatus` is a PURE function (exported, unit-testable) that maps the
 * SDK's chat status + a turn's parts + its PERSISTED metadata to the D-B4 machine.
 */

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type ChatStatus, type UIMessage } from "ai";
import { useCSRF } from "@/hooks/use-csrf";
import type {
  AssistantMessageMetadata,
  EnvelopeC2,
  ValidatedUserMessage,
} from "@/lib/assistant/thread-contracts";

// ---------------------------------------------------------------------------
// State-machine derivation (pure)
// ---------------------------------------------------------------------------

export type TurnStatus =
  | "submitting"
  | "streaming"
  | "completed"
  | "stopped"
  | "failed-before-content"
  | "failed-after-content"
  | "step-capped"
  | "length-capped"
  | "truncated";

/** An assistant turn has content once it has any non-empty text or any tool. */
export function assistantHasContent(m?: UIMessage): boolean {
  if (!m) return false;
  return m.parts.some(
    (p) => (p.type === "text" && p.text.trim().length > 0) || isToolUIPart(p),
  );
}

function assistantHasTruncatedTool(m?: UIMessage): boolean {
  if (!m) return false;
  return m.parts.some((p) => {
    if (!isToolUIPart(p)) return false;
    if (p.state !== "output-available") return false;
    const out = p.output as { status?: string } | undefined;
    return out?.status === "truncated";
  });
}

/** The turn metadata the finalizer persists (T0) — present on RESUMED turns, and
 *  carrying `finishReason` on a live turn once "finish" lands. */
function metadataOf(m?: UIMessage): AssistantMessageMetadata | undefined {
  return (m?.metadata ?? undefined) as AssistantMessageMetadata | undefined;
}

/**
 * Map the SDK chat status + a turn's assistant message to the D-B4 machine.
 * `isActive` is true only for the last turn while the chat is not idle.
 *
 * The SIGNATURE is fixed (every transcript call site passes exactly this): the
 * persisted-metadata truth is read from `assistant.metadata` INTERNALLY, so a
 * thread reloaded from the database renders stopped/failed/capped turns honestly
 * instead of flattening them all to "completed".
 */
export function deriveTurnStatus(args: {
  assistant?: UIMessage;
  isActive: boolean;
  chatStatus: ChatStatus;
  stopped: boolean;
}): TurnStatus {
  const { assistant, isActive, chatStatus, stopped } = args;
  if (stopped) return "stopped";

  const content = assistantHasContent(assistant);
  if (isActive) {
    if (chatStatus === "submitted") return content ? "streaming" : "submitting";
    if (chatStatus === "streaming") return "streaming";
    if (chatStatus === "error") {
      return content ? "failed-after-content" : "failed-before-content";
    }
  }

  // Terminal: a completed active turn OR any historical turn. Persisted metadata
  // wins in T4's order — aborted, then errorCode, then the finish-reason caps (a
  // stopped turn that also carries a trimmed tool result is still "stopped").
  const meta = metadataOf(assistant);
  if (meta?.aborted === true) return "stopped";
  if (meta?.errorCode) return content ? "failed-after-content" : "failed-before-content";
  if (assistantHasTruncatedTool(assistant)) return "truncated";
  const fr = meta?.finishReason;
  // Two DISTINCT failures (review M3): "tool-calls" = the model hit the step cap
  // before finishing its work; "length" = the model's own ANSWER was cut off at the
  // output-token ceiling. They need different copy, so they are different states.
  if (fr === "tool-calls") return "step-capped";
  if (fr === "length") return "length-capped";
  return "completed";
}

// ---------------------------------------------------------------------------
// Error classification (page-level states)
// ---------------------------------------------------------------------------

export type ChatErrorKind =
  | "unconfigured"
  | "rate-limited"
  | "busy"
  | "provider-unavailable"
  | "generic";

/**
 * Classify a `useChat` error into a page-level state. Guard failures arrive as
 * the JSON body text (the transport throws `new Error(await response.text())`);
 * stream errors arrive as the masked fixed code string.
 *
 * THREAD_BUSY (409) is matched on the `code` field ONLY — never on the message
 * prose, which differs between the claim path and the delete path by design.
 */
export function classifyChatError(
  error: Error | undefined,
): { kind: ChatErrorKind; retryAt?: string } | null {
  if (!error) return null;
  const msg = error.message ?? "";
  try {
    const parsed = JSON.parse(msg) as { code?: string; retryAt?: string };
    if (parsed && typeof parsed === "object") {
      if (parsed.code === "AI_UNCONFIGURED") return { kind: "unconfigured" };
      if (parsed.code === "RATE_LIMITED") {
        return { kind: "rate-limited", retryAt: parsed.retryAt };
      }
      if (parsed.code === "THREAD_BUSY") return { kind: "busy" };
    }
  } catch {
    /* not JSON — fall through to substring checks */
  }
  if (msg.includes("AI_UNCONFIGURED")) return { kind: "unconfigured" };
  if (msg.includes("RATE_LIMITED")) return { kind: "rate-limited" };
  if (msg.includes("PROVIDER_ERROR") || msg.includes("TOOL_ERROR") || msg.includes("STEP_LIMIT")) {
    return { kind: "provider-unavailable" };
  }
  return { kind: "generic" };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface UseAssistantChat {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  csrfReady: boolean;
  /**
   * Readiness probe result (U1): `false` once the GET /api/assistant probe
   * reports the provider is unconfigured (lets the page fork the unconfigured
   * panel BEFORE the first submit); `null` while the probe is pending or failed
   * (the page falls back to the reactive 409 fork).
   */
  configured: boolean | null;
  stoppedIds: Set<string>;
  input: string;
  setInput: (v: string) => void;
  sendPrompt: (text: string) => void;
  stop: () => void;
  retry: () => void;
  /** The server thread this chat is writing to: `null` until the first response's
   *  metadata names it (a brand-new thread) or `openThread` sets it. */
  threadId: string | null;
  /** Resume a persisted thread: remounts the chat (new `chatKey`) with `messages`
   *  as its transcript and points the transport at `id`. The caller owns the fetch. */
  openThread: (id: string, messages: UIMessage[]) => void;
  /** Blank composer, no transcript, `threadId: null` until the first send. */
  newThread: () => void;
  /** A 409 THREAD_BUSY came back: this thread is already streaming somewhere else. */
  busyInAnotherSession: boolean;
}

/** The sessionStorage key holding the last thread opened IN THIS TAB. Per-tab is by
 *  design (C5): a new tab lands on the blank composer. Written here; the page owns
 *  the read + the resume fetch. */
export const LAST_THREAD_STORAGE_KEY = "assistant:lastThreadId";

/** Client-owned `useChat` ids. Monotonic and opaque — never a server thread id. */
let chatKeySeq = 0;
const nextChatKey = (): string => `assistant-chat-${++chatKeySeq}`;

function rememberLastThread(threadId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (threadId === null) window.sessionStorage.removeItem(LAST_THREAD_STORAGE_KEY);
    else window.sessionStorage.setItem(LAST_THREAD_STORAGE_KEY, threadId);
  } catch {
    /* private mode / quota — last-open resume is best-effort, never load-bearing */
  }
}

export function useAssistantChat(): UseAssistantChat {
  const { token: csrfToken } = useCSRF();
  const csrfReady = !!csrfToken;

  // The transport reads the LATEST token via a ref, so a refreshed token is
  // always attached even though the transport is built once.
  const tokenRef = React.useRef<string | null>(csrfToken);
  tokenRef.current = csrfToken;

  // The server thread id lives in a REF because the memoized transport reads it at
  // send time (C10); the mirrored state exists only so the UI re-renders.
  const threadIdRef = React.useRef<string | null>(null);
  const [threadId, setThreadId] = React.useState<string | null>(null);

  // The client-owned chat key AND the transcript a remount starts from. They change
  // together, and ONLY on openThread / newThread — never when a thread id arrives.
  const [chatSession, setChatSession] = React.useState<{ key: string; messages: UIMessage[] }>(
    () => ({ key: nextChatKey(), messages: [] }),
  );

  const transport = React.useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/assistant",
        headers: () => ({ "x-csrf-token": tokenRef.current ?? "" }),
        // The C2 envelope: the SDK's { messages, id, trigger, messageId } collapses
        // to the single new/last message plus the thread id. `messageId` is passed
        // through (the server accepts and ignores it — the message IS the anchor).
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => {
          const last = messages[messages.length - 1] as unknown as ValidatedUserMessage;
          const body: EnvelopeC2 = {
            threadId: threadIdRef.current,
            message: last,
            trigger,
            messageId,
          };
          return { body };
        },
      }),
    [],
  );

  const chat = useChat({ id: chatSession.key, messages: chatSession.messages, transport });

  const [input, setInput] = React.useState("");
  const [stoppedIds, setStoppedIds] = React.useState<Set<string>>(() => new Set());

  // C3: the thread id rides `messageMetadata` on this response's "start" (and again
  // on "finish"). Read off the FIRST carrier seen — persisted history never carries
  // one (the finalizer strips it), so the first carrier is always this stream's own
  // thread, and a re-read can never re-point a live chat.
  React.useEffect(() => {
    for (const m of chat.messages) {
      const carried = (m.metadata as { threadId?: unknown } | undefined)?.threadId;
      if (typeof carried === "string" && carried.length > 0) {
        if (threadIdRef.current !== carried) {
          threadIdRef.current = carried;
          setThreadId(carried);
        }
        return;
      }
    }
  }, [chat.messages]);

  // Last-open persistence. Clearing is explicit (newThread) so an unrelated null
  // never wipes a tab's resume target.
  React.useEffect(() => {
    if (threadId !== null) rememberLastThread(threadId);
  }, [threadId]);

  const openThread = React.useCallback((id: string, messages: UIMessage[]) => {
    threadIdRef.current = id;
    setThreadId(id);
    // stoppedIds is a live-session-only optimization: the resumed turns carry their
    // own persisted metadata, so the old set would only mis-mark ids.
    setStoppedIds(new Set());
    setChatSession({ key: nextChatKey(), messages });
  }, []);

  const newThread = React.useCallback(() => {
    threadIdRef.current = null;
    setThreadId(null);
    setStoppedIds(new Set());
    setInput("");
    rememberLastThread(null);
    setChatSession({ key: nextChatKey(), messages: [] });
  }, []);

  // Readiness probe (U1): fetch the provider-configured signal on mount so the
  // page can fork the unconfigured panel BEFORE the first submit. A failed probe
  // leaves `configured` null and the reactive 409 fork remains the fallback.
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/assistant", { method: "GET", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { configured?: boolean } | null) => {
        if (!cancelled && data && typeof data.configured === "boolean") {
          setConfigured(data.configured);
        }
      })
      .catch(() => {
        /* probe failed — keep null; the reactive 409 fork covers it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sendPrompt = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !csrfReady) return;
      setInput("");
      void chat.sendMessage({ text: trimmed });
    },
    [chat, csrfReady],
  );

  const stop = React.useCallback(() => {
    const last = chat.messages[chat.messages.length - 1];
    if (last) {
      setStoppedIds((s) => {
        const next = new Set(s);
        next.add(last.id);
        return next;
      });
    }
    void chat.stop();
  }, [chat]);

  const retry = React.useCallback(() => {
    chat.clearError();
    void chat.regenerate();
  }, [chat]);

  const busyInAnotherSession = classifyChatError(chat.error)?.kind === "busy";

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    csrfReady,
    configured,
    stoppedIds,
    input,
    setInput,
    sendPrompt,
    stop,
    retry,
    threadId,
    openThread,
    newThread,
    busyInAnotherSession,
  };
}
