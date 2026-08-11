"use client";

/**
 * components/assistant/thread-sidebar.tsx — the assistant's thread list
 * (multi-user spec C5; contract pack T0/REV-5).
 *
 *   - desktop: a collapsible `bg-surface` rail beside the transcript column
 *     (`bg-card` is unregistered in this repo BY DESIGN — panels use `surface`);
 *   - mobile (<=768px): the same panel behind a sheet/drawer affordance;
 *   - contents: "New thread", the caller's threads (title or "Untitled" +
 *     relative time from `updatedAt`), the active-thread highlight, per-thread
 *     delete behind a confirm, and load-more past the first page.
 *
 * TITLES ARE TEXT NODES, never markdown and never `dangerouslySetInnerHTML`:
 * a C6 model-generated title is untrusted output derived from the user's own
 * first message, so the injection posture is "render it inert, always".
 *
 * The list is one `useInfiniteQuery` whose page param IS the wire's `offset`;
 * pagination TERMINATES on `nextOffset === null` (pack REV-5 — the route never
 * COUNTs, it over-fetches one row). Delete is optimistic against the cached
 * pages with a snapshot rollback + toast on failure; the caller is told which
 * id went (`onThreadDeleted`) so the PAGE, which owns the chat, can decide
 * whether that was the open one.
 */

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { ThreadListResponse } from "@/lib/assistant/thread-contracts";

/** The one cache key for the thread list. Exported for EXACTLY ONE outside
 *  consumer (W2S-2): the page's freshness effect, which invalidates the list on
 *  stream settle + busy-clear because the 5-minute staleTime would otherwise show
 *  stale titles and ordering. Everything else still talks through props. */
export const THREADS_QUERY_KEY = ["assistant-threads"] as const;

/** The C5 page size (the route clamps anything above 50 and echoes what it used). */
const PAGE_LIMIT = 20;

type ThreadListItem = ThreadListResponse["items"][number];

interface ThreadFetchError extends Error {
  status?: number;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function getJSON(url: string, signal?: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`) as ThreadFetchError;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Module-scope select: a per-render closure would hand back a fresh array on
// every render (the use-product-history.ts precedent).
const selectThreads = (data: InfiniteData<ThreadListResponse>): ThreadListItem[] =>
  data.pages.flatMap((page) => page.items);

function useThreadList() {
  return useInfiniteQuery({
    queryKey: THREADS_QUERY_KEY,
    queryFn: async ({ pageParam, signal }) =>
      (await getJSON(
        `/api/assistant/threads?limit=${PAGE_LIMIT}&offset=${pageParam as number}`,
        signal,
      )) as ThreadListResponse,
    initialPageParam: 0,
    // `undefined` is TanStack's "no more pages" — and `nextOffset: null` is the
    // wire's. This is the ONLY termination signal (never a short page).
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    select: selectThreads,
  });
}

function useDeleteThread(onThreadDeleted?: (id: string) => void) {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();

  return useMutation<unknown, Error, string, { previous?: InfiniteData<ThreadListResponse> }>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/assistant/threads/${id}`, {
        method: "DELETE",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || "Could not delete conversation") as ThreadFetchError;
        err.status = res.status;
        throw err;
      }
      return res.json().catch(() => ({}));
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: THREADS_QUERY_KEY });
      const previous =
        queryClient.getQueryData<InfiniteData<ThreadListResponse>>(THREADS_QUERY_KEY);
      queryClient.setQueryData<InfiniteData<ThreadListResponse>>(THREADS_QUERY_KEY, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            }
          : old,
      );
      return { previous };
    },
    onError: (err, _id, context) => {
      // Rollback: the row comes BACK, and the failure is spoken aloud. A silently
      // vanished conversation would be a lie about what the server did.
      if (context?.previous) queryClient.setQueryData(THREADS_QUERY_KEY, context.previous);
      toast.error(err?.message || "Could not delete conversation");
    },
    // Only a CONFIRMED delete tells the page to move on — a rolled-back one must
    // not strand the user on a blank composer.
    onSuccess: (_data, id) => onThreadDeleted?.(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: THREADS_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** ISO string in, human string out. An unparseable date renders nothing rather
 *  than "Invalid Date" (truthful-data house rule). */
function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDistanceToNow(d, { addSuffix: true });
}

function ListSkeleton() {
  return (
    <div className="space-y-2 px-1 py-2" data-testid="thread-list-skeleton">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function DeleteThreadButton({
  item,
  disabled,
  onConfirm,
}: {
  item: ThreadListItem;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const label = item.title ?? "Untitled";
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={`thread-delete-${item.id}`}
          aria-label={`Delete conversation: ${label}`}
          title={disabled ? "Stop the response first" : "Delete conversation"}
          className="absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          {/* The title is untrusted text — interpolated as a TEXT NODE. */}
          <AlertDialogTitle>Delete “{label}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the conversation and its messages. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep conversation</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            onClick={onConfirm}
          >
            Delete conversation
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ThreadRow({
  item,
  isActive,
  isStreaming,
  onSelect,
  onDelete,
}: {
  item: ThreadListItem;
  isActive: boolean;
  isStreaming: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        data-testid={`thread-item-${item.id}`}
        aria-current={isActive ? "true" : undefined}
        className={cn(
          "flex min-h-[44px] w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 pr-10 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          isActive ? "bg-surface-hover font-medium" : "hover:bg-surface-hover",
        )}
      >
        <span className="w-full truncate text-body-sm">{item.title ?? "Untitled"}</span>
        <span className="text-caption text-muted-foreground">{relativeTime(item.updatedAt)}</span>
      </button>
      <DeleteThreadButton
        item={item}
        disabled={isStreaming}
        onConfirm={() => onDelete(item.id)}
      />
    </li>
  );
}

interface ThreadSidebarProps {
  /** The thread the chat is currently pointed at (`null` = a brand-new one). */
  activeThreadId: string | null;
  /** The thread streaming RIGHT HERE — its delete is disabled (C5: the route
   *  would 409 THREAD_BUSY anyway; refusing the click is the honest UI). */
  streamingThreadId?: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  /** A CONFIRMED delete. The page decides whether it was the open thread. */
  onThreadDeleted?: (id: string) => void;
}

/** The list body — shared verbatim by the desktop rail and the mobile sheet. */
function ThreadPanel({
  activeThreadId,
  streamingThreadId,
  onSelectThread,
  onNewThread,
  onThreadDeleted,
}: ThreadSidebarProps) {
  const queryClient = useQueryClient();
  const query = useThreadList();
  const remove = useDeleteThread(onThreadDeleted);
  // Memoised: react-query's `data` is referentially stable, but the `?? []`
  // fallback would hand the effect below a fresh array on every render.
  const items = React.useMemo(() => query.data ?? [], [query.data]);

  // A brand-new thread exists on the server long before this list knows about
  // it: the id arrives on the FIRST response's metadata (C3), and the cached
  // list is 5 minutes stale by default. Without this the conversation the user
  // is having would be missing from the list of conversations — and the active
  // highlight would have no row to land on. Bounded to ONE refetch per id
  // (`refreshedFor`) so a thread the server genuinely does not return here can
  // never spin the query.
  const refreshedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!activeThreadId || query.isPending || query.isError) return;
    if (refreshedFor.current === activeThreadId) return;
    if (items.some((item) => item.id === activeThreadId)) return;
    refreshedFor.current = activeThreadId;
    void queryClient.invalidateQueries({ queryKey: THREADS_QUERY_KEY });
  }, [activeThreadId, items, query.isPending, query.isError, queryClient]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pb-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={onNewThread}
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden />
          New thread
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {query.isPending ? (
          <ListSkeleton />
        ) : query.isError ? (
          <div className="px-3 py-6">
            <p className="text-body-sm text-muted-foreground">Couldn’t load conversations.</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 px-0"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-6 text-body-sm text-muted-foreground">No conversations yet</p>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <ThreadRow
                key={item.id}
                item={item}
                isActive={item.id === activeThreadId}
                isStreaming={!!streamingThreadId && item.id === streamingThreadId}
                onSelect={onSelectThread}
                onDelete={(id) => remove.mutate(id)}
              />
            ))}
          </ul>
        )}

        {query.hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ThreadSidebar(props: ThreadSidebarProps) {
  const isMobile = useIsMobile(768);
  const [collapsed, setCollapsed] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  if (isMobile) {
    // Mobile (<=768px): a drawer affordance in a slim bar above the transcript.
    // Picking a thread or starting a new one closes the sheet — the point of the
    // tap was to get back to the conversation.
    const closeThen =
      <T extends unknown[]>(fn: (...args: T) => void) =>
      (...args: T) => {
        setSheetOpen(false);
        fn(...args);
      };
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
              Conversations
            </Button>
          </SheetTrigger>
          <SheetContent side="left" motion="quick" className="w-[85vw] max-w-[20rem] bg-surface p-0">
            <SheetHeader className="px-4 pb-2 pt-4">
              <SheetTitle className="text-h4">Conversations</SheetTitle>
            </SheetHeader>
            <div className="h-[calc(100%-3.5rem)]">
              <ThreadPanel
                {...props}
                onSelectThread={closeThen(props.onSelectThread)}
                onNewThread={closeThen(props.onNewThread)}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-surface py-2">
        <button
          type="button"
          aria-label="Show conversations"
          onClick={() => setCollapsed(false)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PanelLeftOpen className="h-4 w-4" aria-hidden />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-label uppercase text-muted-foreground">Conversations</h2>
        <button
          type="button"
          aria-label="Hide conversations"
          onClick={() => setCollapsed(true)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PanelLeftClose className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ThreadPanel {...props} />
      </div>
    </aside>
  );
}
