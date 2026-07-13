"use client";

/**
 * components/assistant/transcript.tsx — the ordered list of grouped turns
 * (spec §12 D-B1/D-B5/D-B10).
 *
 *   - one user message + its assistant/tool response = one grouped turn; turns
 *     are `space-y-6`, each an <li> in an ordered <ol> with visible You/Assistant
 *     labels;
 *   - the scroll container auto-sticks to the bottom ONLY within ~80px of it; a
 *     user who scrolls up is never yanked — a "Jump to latest" pill returns them;
 *     scrolling is instant under reduced motion;
 *   - ONE visually-hidden status region announces lifecycle MILESTONES only
 *     (streamed text carries no aria-live).
 */

import * as React from "react";
import { ArrowDown } from "lucide-react";
import { getToolName, isToolUIPart, type ChatStatus, type UIMessage } from "ai";
import { MessageTurn } from "@/components/assistant/message-turn";
import { StatusRegion } from "@/components/assistant/status-region";
import { TOOL_PRESENTATION } from "@/lib/assistant/tool-presentation";
import { deriveTurnStatus, type TurnStatus } from "@/hooks/use-assistant-chat";

interface Turn {
  key: string;
  user?: UIMessage;
  assistant?: UIMessage;
}

function buildTurns(messages: UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({ key: m.id, user: m });
    } else if (m.role === "assistant") {
      const last = turns[turns.length - 1];
      if (last && !last.assistant) last.assistant = m;
      else turns.push({ key: m.id, assistant: m });
    }
  }
  return turns;
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduce;
}

/** The single milestone string for the active turn (D-B10). Stable while a phase
 *  persists, so the polite region announces once per milestone. */
function milestoneFor(status: TurnStatus, assistant?: UIMessage): string {
  switch (status) {
    case "submitting":
      return "Assistant is responding.";
    case "streaming": {
      const pending = assistant?.parts.find(
        (p) => isToolUIPart(p) && (p.state === "input-available" || p.state === "input-streaming"),
      );
      if (pending) {
        const label = TOOL_PRESENTATION[getToolName(pending as Parameters<typeof getToolName>[0])]
          ?.pendingLabel;
        if (label) return label;
      }
      return "Assistant is responding.";
    }
    case "completed":
    case "step-capped":
    case "truncated":
      return "Response complete.";
    case "stopped":
      return "Response stopped.";
    case "failed-before-content":
    case "failed-after-content":
      return "Assistant response failed.";
    default:
      return "";
  }
}

export function Transcript({
  messages,
  chatStatus,
  stoppedIds,
  onRetry,
}: {
  messages: UIMessage[];
  chatStatus: ChatStatus;
  stoppedIds: Set<string>;
  onRetry: () => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const atBottomRef = React.useRef(true);
  const [showJump, setShowJump] = React.useState(false);
  const reduceMotion = usePrefersReducedMotion();

  const turns = React.useMemo(() => buildTurns(messages), [messages]);
  const lastIndex = turns.length - 1;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setShowJump(!near);
  };

  const scrollToBottom = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }, [reduceMotion]);

  // Auto-stick on content change, but only while the user is near the bottom.
  React.useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  const activeStatus =
    lastIndex >= 0
      ? deriveTurnStatus({
          assistant: turns[lastIndex].assistant,
          isActive: true,
          chatStatus,
          stopped:
            (turns[lastIndex].assistant && stoppedIds.has(turns[lastIndex].assistant!.id)) ||
            (turns[lastIndex].user && stoppedIds.has(turns[lastIndex].user!.id)) ||
            false,
        })
      : "completed";

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-4 py-6"
        data-testid="assistant-transcript"
      >
        <ol className="mx-auto w-full max-w-[52rem] space-y-6">
          {turns.map((turn, i) => {
            const isActive = i === lastIndex;
            const stopped =
              (turn.assistant && stoppedIds.has(turn.assistant.id)) ||
              (turn.user && stoppedIds.has(turn.user.id)) ||
              false;
            const status = deriveTurnStatus({
              assistant: turn.assistant,
              isActive,
              chatStatus,
              stopped,
            });
            return (
              <MessageTurn
                key={turn.key}
                user={turn.user}
                assistant={turn.assistant}
                status={status}
                onRetry={onRetry}
              />
            );
          })}
        </ol>
      </div>

      {showJump && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 inline-flex min-h-[44px] -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-4 text-body-sm shadow-dropdown transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowDown className="h-4 w-4" aria-hidden />
          Jump to latest
        </button>
      )}

      <StatusRegion message={milestoneFor(activeStatus, turns[lastIndex]?.assistant)} />
    </div>
  );
}
