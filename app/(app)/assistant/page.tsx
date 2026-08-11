"use client";

/**
 * app/(app)/assistant/page.tsx — the in-app assistant surface (spec §12;
 * multi-user spec C5/C10).
 *
 * Owns the D-B5 column: `h-full flex flex-col min-h-0` (the shell provides the
 * definite-height seam), a flex-1 middle that scrolls, and a pinned composer
 * (sticky above the mobile dock with safe-area padding). Forks the D-B7 states:
 * boot / empty (three tap-to-POPULATE prompts) / provider-unconfigured (role
 * forked — non-admin gets NO admin link) / rate-limited; provider/stream errors
 * surface in-transcript as a failed turn with Retry.
 *
 * C5 adds the thread states on top of those, all of them owned HERE (the hook
 * owns the chat, the sidebar owns the list, the page owns the transitions):
 *
 *   - MOUNT RESUME: `sessionStorage` names the last thread opened IN THIS TAB
 *     (the hook writes the key, this page reads it). A 200 remounts the chat on
 *     the loaded transcript; a 404 means it was deleted in another session, so
 *     the key is cleared and the tab lands on the blank composer. Per-tab is BY
 *     DESIGN: a brand-new tab starts blank.
 *   - SWITCH: a skeleton stands in for the transcript while the GET resolves; a
 *     failure shows an inline error with Retry and KEEPS the current thread
 *     mounted — a load that failed must never destroy what was on screen.
 *   - BUSY: a thread that is already generating when opened cannot be typed
 *     into. Its detail route is re-polled every 2s until `activeRequest` clears,
 *     then the chat remounts on the finished transcript.
 */

import * as React from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import type { UIMessage } from "ai";
import { Skeleton } from "@/components/ui/skeleton";
import { Composer } from "@/components/assistant/composer";
import { Transcript } from "@/components/assistant/transcript";
import { ThreadSidebar } from "@/components/assistant/thread-sidebar";
import {
  useAssistantChat,
  classifyChatError,
  LAST_THREAD_STORAGE_KEY,
} from "@/hooks/use-assistant-chat";
import type { ThreadDetailResponse, ThreadMessageDto } from "@/lib/assistant/thread-contracts";

const EXAMPLE_PROMPTS = [
  "What's low on stock right now?",
  "How have sales trended over the last 30 days?",
  "What's my current inventory valuation?",
];

/** C5: how often a thread that was BUSY WHEN OPENED re-checks the detail route.
 *  The poll re-fetches the whole transcript — the accepted cost of having one
 *  detail surface rather than two (pack REV-5). */
const BUSY_POLL_MS = 2_000;

interface ThreadFetchError extends Error {
  status?: number;
}

async function fetchThreadDetail(id: string): Promise<ThreadDetailResponse> {
  const res = await fetch(`/api/assistant/threads/${id}`, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`) as ThreadFetchError;
    // Clients branch on STATUS/CODE, never on message prose (pack REV-5).
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as ThreadDetailResponse;
}

/**
 * `ThreadMessageDto[]` (the wire) -> `UIMessage[]` (what `openThread` wants).
 *
 * SYSTEM ROWS ARE DROPPED HERE, deliberately. `Transcript.buildTurns` groups
 * only `user`/`assistant` rows and ignores everything else SILENTLY, so a system
 * row could never render either way; filtering at the mapping makes the omission
 * a stated decision rather than an accident two components away. Parts pass
 * through unchecked (the route stores what it validated); `metadata: null`
 * becomes `undefined` so `deriveTurnStatus` reads it as "no terminal metadata".
 */
function toUIMessages(rows: ThreadMessageDto[]): UIMessage[] {
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map(
      (row) =>
        ({
          id: row.id,
          role: row.role,
          parts: row.parts,
          metadata: row.metadata ?? undefined,
        }) as UIMessage,
    );
}

function readLastThread(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(LAST_THREAD_STORAGE_KEY);
  } catch {
    return null; // private mode / quota — resume is best-effort, never load-bearing
  }
}

function clearLastThread(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(LAST_THREAD_STORAGE_KEY);
  } catch {
    /* see readLastThread */
  }
}

function BootSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[52rem] space-y-4 px-4 py-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-16 w-3/4" />
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-[52rem] flex-col justify-center px-4 py-6">
      <h1 className="text-h2 font-semibold">Assistant</h1>
      <p className="mt-2 text-body text-muted-foreground">
        I answer from your live inventory data — I can&rsquo;t guess.
      </p>
      <ul className="mt-6 space-y-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => onPick(prompt)}
              className="flex min-h-[44px] w-full items-center rounded-lg border border-border bg-surface px-4 py-2 text-left text-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnconfiguredPanel({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-[52rem] flex-col justify-center px-4 py-6">
      <div className="rounded-lg border border-info-border bg-info-muted px-4 py-4">
        <p className="text-body text-info-foreground">
          The assistant isn&rsquo;t set up yet. Ask an admin to configure an AI provider.
        </p>
        {isAdmin && (
          <Link
            href="/admin/settings/ai"
            className="mt-3 inline-flex min-h-[44px] items-center text-body font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Configure AI providers
          </Link>
        )}
      </div>
    </div>
  );
}

/** The C5 switch state: a skeleton stands in for the transcript, never a blank. */
function TranscriptSkeleton() {
  return (
    <div
      data-testid="transcript-skeleton"
      className="mx-auto w-full max-w-[52rem] space-y-4 px-4 py-6"
    >
      <Skeleton className="ml-auto h-10 w-2/3" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="ml-auto h-10 w-1/2" />
      <Skeleton className="h-16 w-3/4" />
    </div>
  );
}

function RateLimitedPanel({ retryAt }: { retryAt?: string }) {
  const time = React.useMemo(() => {
    if (!retryAt) return "shortly";
    const d = new Date(retryAt);
    return Number.isNaN(d.getTime()) ? "shortly" : d.toLocaleTimeString();
  }, [retryAt]);
  return (
    <div className="mx-auto flex h-full w-full max-w-[52rem] flex-col justify-center px-4 py-6">
      <div className="rounded-lg border border-warning-border bg-warning-muted px-4 py-4">
        <p className="text-body text-warning-foreground">
          Assistant is temporarily rate-limited. Try again at {time}.
        </p>
      </div>
    </div>
  );
}

export default function AssistantPage() {
  const { data: session } = useSession();
  const isAdmin = !!session?.user?.isAdmin;

  const {
    messages,
    status,
    error,
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
  } = useAssistantChat();

  // `openThread` is stable, but reading it through a ref keeps the poll effect
  // armed on `busyThreadId` ALONE — an unrelated re-render must never restart
  // the 2s clock.
  const openThreadRef = React.useRef(openThread);
  openThreadRef.current = openThread;

  /** The thread whose detail GET is in flight (drives the switch skeleton). */
  const [loadingThreadId, setLoadingThreadId] = React.useState<string | null>(null);
  /** The thread whose load FAILED — the current thread stays mounted behind it. */
  const [loadErrorId, setLoadErrorId] = React.useState<string | null>(null);
  /** The thread that was BUSY when opened: banner + poll. This is the C5 signal
   *  and it is NEVER the hook's `busyInAnotherSession` (that one is the chat
   *  POST's 409). Two signals, two owners, one banner. */
  const [busyThreadId, setBusyThreadId] = React.useState<string | null>(null);
  /** Last-write-wins across overlapping loads (rapid switching, retry, resume). */
  const loadSeqRef = React.useRef(0);

  const loadThread = React.useCallback(async (id: string, opts?: { resume?: boolean }) => {
    const seq = (loadSeqRef.current += 1);
    setLoadingThreadId(id);
    setLoadErrorId(null);
    try {
      const detail = await fetchThreadDetail(id);
      if (seq !== loadSeqRef.current) return;
      openThreadRef.current(id, toUIMessages(detail.messages));
      setBusyThreadId(detail.activeRequest ? id : null);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      // Resume-time 404 = deleted in another session. Drop the stale key and
      // land on the blank composer; there is nothing to retry.
      if (opts?.resume && (err as ThreadFetchError).status === 404) {
        clearLastThread();
        return;
      }
      setLoadErrorId(id);
    } finally {
      if (seq === loadSeqRef.current) setLoadingThreadId(null);
    }
  }, []);

  // Mount resume — once. `loadThread` is stable, so this never re-fires.
  React.useEffect(() => {
    const stored = readLastThread();
    if (stored) void loadThread(stored, { resume: true });
  }, [loadThread]);

  // The C5 busy poll. Keyed on `busyThreadId` only.
  React.useEffect(() => {
    const id = busyThreadId;
    if (!id) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const detail = await fetchThreadDetail(id);
          if (cancelled || detail.activeRequest) return;
          setBusyThreadId(null);
          openThreadRef.current(id, toUIMessages(detail.messages));
        } catch {
          // A transient failure keeps the banner up: the honest statement is
          // still "something else is generating", not "it finished".
        }
      })();
    }, BUSY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [busyThreadId]);

  const handleNewThread = React.useCallback(() => {
    loadSeqRef.current += 1; // abandon any in-flight load
    setLoadingThreadId(null);
    setLoadErrorId(null);
    setBusyThreadId(null);
    newThread();
  }, [newThread]);

  const handleSelectThread = React.useCallback(
    (id: string) => {
      if (id === threadId && loadErrorId === null) return;
      void loadThread(id);
    },
    [loadThread, loadErrorId, threadId],
  );

  const handleThreadDeleted = React.useCallback(
    (id: string) => {
      if (id === threadId) handleNewThread();
    },
    [handleNewThread, threadId],
  );

  const errorInfo = classifyChatError(error);
  const rateLimited = errorInfo?.kind === "rate-limited";
  const streaming = status === "streaming" || status === "submitted";
  // The readiness probe (configured === false) forks the panel BEFORE the first
  // submit; the reactive 409 (errorInfo unconfigured) stays as the fallback.
  const unconfigured = configured === false || errorInfo?.kind === "unconfigured";
  const switching = loadingThreadId !== null;
  // ONE banner, TWO independent causes — the poll is armed by `busyThreadId`
  // alone; `busyInAnotherSession` only shares the copy and the disabled composer.
  const busyElsewhere = busyThreadId !== null || busyInAnotherSession;

  let body: React.ReactNode;
  if (unconfigured) {
    body = <UnconfiguredPanel isAdmin={isAdmin} />;
  } else if (!csrfReady) {
    body = <BootSkeleton />;
  } else if (rateLimited) {
    body = <RateLimitedPanel retryAt={errorInfo?.retryAt} />;
  } else if (switching) {
    body = <TranscriptSkeleton />;
  } else if (messages.length === 0) {
    body = <EmptyState onPick={setInput} />;
  } else {
    body = (
      <Transcript
        messages={messages}
        chatStatus={status}
        stoppedIds={stoppedIds}
        onRetry={retry}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <ThreadSidebar
        activeThreadId={threadId}
        streamingThreadId={streaming ? threadId : null}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onThreadDeleted={handleThreadDeleted}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {busyElsewhere && (
          <div className="border-b border-info-border bg-info-muted px-4 py-2">
            <p className="mx-auto w-full max-w-[52rem] text-body-sm text-info-foreground">
              A response is being generated in another session. This conversation will update when
              it finishes.
            </p>
          </div>
        )}

        {loadErrorId && (
          <div className="border-b border-warning-border bg-warning-muted px-4 py-2">
            <div className="mx-auto flex w-full max-w-[52rem] items-center justify-between gap-3">
              <p className="text-body-sm text-warning-foreground">
                Couldn’t load that conversation.
              </p>
              <button
                type="button"
                onClick={() => void loadThread(loadErrorId)}
                className="min-h-[32px] shrink-0 text-body-sm font-medium text-warning-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        <div className="relative min-h-0 min-w-0 flex-1">{body}</div>
        <div className="border-t border-border bg-background p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto w-full max-w-[52rem]">
            <Composer
              value={input}
              onValueChange={setInput}
              onSubmit={() => sendPrompt(input)}
              onStop={stop}
              streaming={streaming}
              csrfReady={csrfReady}
              disabled={!csrfReady || rateLimited || busyElsewhere}
              placeholder={csrfReady ? "Ask about your inventory…" : "Preparing Assistant…"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
