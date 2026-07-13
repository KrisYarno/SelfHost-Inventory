"use client";

/**
 * components/assistant/composer.tsx — the assistant input (spec §12 D-B6).
 *
 *   - a NEW auto-grow textarea (1 line ~40px -> cap ~200px then internal
 *     scroll), NOT the stock 80px Textarea;
 *   - a single Send button that morphs IN PLACE to Stop while streaming (no
 *     second button); the textarea stays enabled during streaming;
 *   - Send disabled while empty/whitespace-only AND until CSRF is ready;
 *   - desktop Enter = send, Shift+Enter = newline, IME composition never sends;
 *     mobile (coarse pointer) Enter = newline, explicit Send tap;
 *   - `aria-describedby` documents the Enter behavior; focus stays here.
 */

import * as React from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";

interface ComposerProps {
  value: string;
  onValueChange: (v: string) => void;
  /** Send the current value (parent trims/validates + resets). */
  onSubmit: () => void;
  onStop: () => void;
  /** While true the Send control is a Stop control; the textarea stays enabled. */
  streaming: boolean;
  /** Send is blocked until the CSRF token is ready (D-B6). */
  csrfReady: boolean;
  /** Hard-disable the whole composer (boot / rate-limited). */
  disabled?: boolean;
  placeholder?: string;
}

/** Coarse pointer => treat Enter as newline (mobile). Desktop Enter sends. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    setCoarse(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return coarse;
}

export function Composer({
  value,
  onValueChange,
  onSubmit,
  onStop,
  streaming,
  csrfReady,
  disabled = false,
  placeholder = "Ask about your inventory…",
}: ComposerProps) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const coarse = useCoarsePointer();
  const hintId = React.useId();

  // Auto-grow: reset then grow to content, capped; internal scroll past the cap.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = csrfReady && !disabled && value.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    onSubmit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    // IME composition: never send mid-composition.
    if (e.nativeEvent.isComposing) return;
    // Shift+Enter and mobile Enter both insert a newline (default behavior).
    if (e.shiftKey || coarse) return;
    e.preventDefault();
    send();
  };

  return (
    <div
      className="flex items-end gap-2 rounded-lg border border-border bg-surface p-2"
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={1}
        placeholder={placeholder}
        aria-label="Message the assistant"
        aria-describedby={hintId}
        className={cn(
          "min-h-[40px] max-h-[200px] flex-1 resize-none bg-transparent px-1 py-2 text-body",
          "placeholder:text-muted-foreground focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      />
      <p id={hintId} className="sr-only">
        {coarse
          ? "Press the Send button to send. Enter adds a new line."
          : "Press Enter to send, Shift+Enter for a new line."}
      </p>

      {streaming ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop response"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-secondary text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Square className="h-4 w-4 fill-current" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send message"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowUp className="h-5 w-5" aria-hidden />
        </button>
      )}
    </div>
  );
}
