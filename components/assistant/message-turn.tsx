"use client";

/**
 * components/assistant/message-turn.tsx — one grouped turn (spec §12 D-B1/D-B4).
 *
 * Flat, asymmetric, NO rail/nodes/bubble-stacks/Cards/shadows:
 *   - the user message: right-aligned contained block, bg-surface rounded-lg
 *     max-w-[36rem];
 *   - the assistant response: FULL-WIDTH on bg-background, headed by an
 *     "Assistant" badge at BODY size (StatusBadge size="body" — the 11px chip may
 *     not be the sole label), prose column max-w-[48rem], tool disclosures escape
 *     the prose cap in their own scroller.
 *
 * The 7-state machine (D-B4) renders as: submitting -> a STATIC "Assistant is
 * working…" + motion-reduce-safe skeleton; streaming -> content; stopped /
 * failed / step-capped / truncated -> content PRESERVED with the right banner
 * (Retry regenerates the last user turn, never duplicating it).
 */

import * as React from "react";
import { Sparkles } from "lucide-react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { StatusBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AssistantMarkdown } from "@/components/assistant/markdown";
import { ToolDisclosure, type ToolInvocationView } from "@/components/assistant/tool-disclosure";
import type { TurnStatus } from "@/hooks/use-assistant-chat";

interface MessageTurnProps {
  user?: UIMessage;
  assistant?: UIMessage;
  status: TurnStatus;
  onRetry: () => void;
}

function userText(m: UIMessage): string {
  return m.parts
    .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Normalize a tool UI part into the disclosure view (client-safe). */
function toToolView(part: UIMessage["parts"][number]): ToolInvocationView {
  const name = getToolName(part as Parameters<typeof getToolName>[0]);
  const tp = part as {
    state?: string;
    input?: unknown;
    output?: {
      status?: "ok" | "truncated" | "error";
      data?: unknown;
      meta?: { scope?: "company" | "global"; dataStart?: string | null };
    };
  };
  const input = tp.input;

  if (tp.state === "output-available" && tp.output) {
    const out = tp.output;
    if (out.status === "ok") {
      return {
        name,
        status: "success",
        input,
        data: out.data,
        scope: out.meta?.scope,
        dataStart: out.meta?.dataStart ?? null,
      };
    }
    if (out.status === "truncated") {
      return { name, status: "truncated", input, scope: out.meta?.scope };
    }
    return { name, status: "error", input, scope: out.meta?.scope };
  }
  if (tp.state === "output-error") return { name, status: "error", input };
  return { name, status: "pending", input };
}

function AssistantHeader() {
  return (
    <StatusBadge tone="info" size="body" className="gap-1">
      <Sparkles className="h-4 w-4" aria-hidden />
      Assistant
    </StatusBadge>
  );
}

function StoppedBanner() {
  return <p className="mt-2 text-body-sm text-muted-foreground">Response stopped.</p>;
}

function AmberBanner({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-md border border-warning-border bg-warning-muted px-3 py-2 text-body-sm text-warning-foreground">
      {children}
    </p>
  );
}

function FailureStrip({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
    >
      <span className="text-body-sm text-destructive">
        Assistant could not reach its AI provider. Try again. If this keeps happening, ask an
        admin to check AI Providers.
      </span>
      <Button variant="outline" size="sm" onClick={onRetry} className="min-h-[44px]">
        Retry
      </Button>
    </div>
  );
}

function AssistantBody({
  assistant,
  status,
  onRetry,
}: {
  assistant?: UIMessage;
  status: TurnStatus;
  onRetry: () => void;
}) {
  const busy = status === "submitting" || status === "streaming";

  return (
    <div className="w-full bg-background" aria-busy={busy || undefined}>
      <AssistantHeader />
      <div className="mt-2 max-w-[48rem] space-y-1">
        {status === "submitting" ? (
          <div className="space-y-2">
            <p className="text-body text-muted-foreground">Assistant is working…</p>
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          assistant?.parts.map((part, i) => {
            if (part.type === "text") {
              return part.text.trim() ? (
                <AssistantMarkdown key={i}>{part.text}</AssistantMarkdown>
              ) : null;
            }
            if (isToolUIPart(part)) {
              return <ToolDisclosure key={i} tool={toToolView(part)} />;
            }
            return null;
          })
        )}

        {status === "stopped" && <StoppedBanner />}
        {status === "step-capped" && (
          <AmberBanner>
            Assistant reached its work limit before finishing. Ask a narrower question or
            continue from the result above.
          </AmberBanner>
        )}
        {status === "truncated" && (
          <AmberBanner>
            Some results were omitted because this request was broad. Narrow the product or
            date range.
          </AmberBanner>
        )}
        {(status === "failed-before-content" || status === "failed-after-content") && (
          <FailureStrip onRetry={onRetry} />
        )}
      </div>
    </div>
  );
}

export function MessageTurn({ user, assistant, status, onRetry }: MessageTurnProps) {
  const showAssistant = status === "submitting" || !!assistant || status.startsWith("failed");

  return (
    <li className="space-y-3 list-none">
      {user && (
        <div className="flex justify-end">
          <div className="max-w-[36rem] rounded-lg bg-surface px-4 py-2.5 text-body">
            <span className="sr-only">You: </span>
            <span className="whitespace-pre-wrap break-words">{userText(user)}</span>
          </div>
        </div>
      )}
      {showAssistant && <AssistantBody assistant={assistant} status={status} onRetry={onRetry} />}
    </li>
  );
}
