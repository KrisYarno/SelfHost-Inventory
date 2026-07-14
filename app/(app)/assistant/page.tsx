"use client";

/**
 * app/(app)/assistant/page.tsx — the in-app assistant surface (spec §12).
 *
 * Owns the D-B5 column: `h-full flex flex-col min-h-0` (the shell provides the
 * definite-height seam), a flex-1 middle that scrolls, and a pinned composer
 * (sticky above the mobile dock with safe-area padding). Forks the D-B7 states:
 * boot / empty (three tap-to-POPULATE prompts) / provider-unconfigured (role
 * forked — non-admin gets NO admin link) / rate-limited; provider/stream errors
 * surface in-transcript as a failed turn with Retry.
 */

import * as React from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Skeleton } from "@/components/ui/skeleton";
import { Composer } from "@/components/assistant/composer";
import { Transcript } from "@/components/assistant/transcript";
import { useAssistantChat, classifyChatError } from "@/hooks/use-assistant-chat";

const EXAMPLE_PROMPTS = [
  "What's low on stock right now?",
  "How have sales trended over the last 30 days?",
  "What's my current inventory valuation?",
];

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
  } = useAssistantChat();

  const errorInfo = classifyChatError(error);
  const rateLimited = errorInfo?.kind === "rate-limited";
  const streaming = status === "streaming" || status === "submitted";
  // The readiness probe (configured === false) forks the panel BEFORE the first
  // submit; the reactive 409 (errorInfo unconfigured) stays as the fallback.
  const unconfigured = configured === false || errorInfo?.kind === "unconfigured";

  let body: React.ReactNode;
  if (unconfigured) {
    body = <UnconfiguredPanel isAdmin={isAdmin} />;
  } else if (!csrfReady) {
    body = <BootSkeleton />;
  } else if (rateLimited) {
    body = <RateLimitedPanel retryAt={errorInfo?.retryAt} />;
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
    <div className="flex h-full min-h-0 flex-col">
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
            disabled={!csrfReady || rateLimited}
            placeholder={csrfReady ? "Ask about your inventory…" : "Preparing Assistant…"}
          />
        </div>
      </div>
    </div>
  );
}
