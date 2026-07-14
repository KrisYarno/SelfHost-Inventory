"use client";

/**
 * hooks/use-assistant-chat.ts — the client transport + state machine for the
 * assistant (spec §11 + §12 D-B4/D-B6/D-B7).
 *
 *   - wraps `useChat` (@ai-sdk/react) over a `DefaultChatTransport` that attaches
 *     `x-csrf-token` on EVERY request (send is disabled until the token is ready)
 *     and a client-minted conversation id (uuid v4, envelope-only — D9);
 *   - tracks user-initiated Stop so a stopped turn preserves its partial content;
 *   - exposes `retry` (regenerate the last user turn WITHOUT duplicating it) and
 *     `classifyChatError` so the page can fork the unconfigured / rate-limited /
 *     provider-unavailable states.
 *
 * `deriveTurnStatus` is a PURE function (exported, unit-testable) that maps the
 * SDK's chat status + a turn's parts to the 7-state D-B4 machine.
 */

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type ChatStatus, type UIMessage } from "ai";
import { v4 as uuidv4 } from "uuid";
import { useCSRF } from "@/hooks/use-csrf";

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

function finishReasonOf(m?: UIMessage): string | undefined {
  const meta = m?.metadata as { finishReason?: string } | undefined;
  return meta?.finishReason;
}

/**
 * Map the SDK chat status + a turn's assistant message to the D-B4 machine.
 * `isActive` is true only for the last turn while the chat is not idle.
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

  // Terminal: a completed active turn OR any historical turn.
  if (assistantHasTruncatedTool(assistant)) return "truncated";
  const fr = finishReasonOf(assistant);
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
  | "provider-unavailable"
  | "generic";

/**
 * Classify a `useChat` error into a page-level state. Guard failures arrive as
 * the JSON body text (the transport throws `new Error(await response.text())`);
 * stream errors arrive as the masked fixed code string.
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
  conversationId: string;
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
}

export function useAssistantChat(): UseAssistantChat {
  const { token: csrfToken } = useCSRF();
  const csrfReady = !!csrfToken;

  // Stable per-mount conversation id (envelope metadata only).
  const conversationId = React.useMemo(() => uuidv4(), []);

  // The transport reads the LATEST token via a ref, so a refreshed token is
  // always attached even though the transport is built once.
  const tokenRef = React.useRef<string | null>(csrfToken);
  tokenRef.current = csrfToken;

  const transport = React.useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/assistant",
        headers: () => ({ "x-csrf-token": tokenRef.current ?? "" }),
        body: { conversationId },
      }),
    [conversationId],
  );

  const chat = useChat({ id: conversationId, transport });

  const [input, setInput] = React.useState("");
  const [stoppedIds, setStoppedIds] = React.useState<Set<string>>(() => new Set());

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

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    conversationId,
    csrfReady,
    configured,
    stoppedIds,
    input,
    setInput,
    sendPrompt,
    stop,
    retry,
  };
}
