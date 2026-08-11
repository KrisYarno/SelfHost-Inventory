"use client";

/**
 * components/assistant/report-dialog.tsx — the per-thread "Report to admin" action
 * and its CONSENT dialog (spec C9; Kris 2026-08-10).
 *
 * This dialog is the privacy design. Reporting is the ONLY way a conversation
 * reaches an administrator — there is no admin-initiated request and no admin
 * browsing of threads — so the copy has to say exactly what crosses: the whole
 * conversation, including the full tool output behind every answer. Anything vaguer
 * ("share this chat") would be collecting consent for something the user did not
 * picture.
 *
 * The client uploads NOTHING but the optional note: the server reads the transcript
 * from its own store, so a report can never contain words nobody said.
 */

import * as React from "react";
import { Flag } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
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
import { Textarea } from "@/components/ui/textarea";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

export const REPORT_ACTION_LABEL = "Report to admin";

export const REPORT_CONSENT_HEADLINE = "Send this whole conversation to the admin?";

export const REPORT_CONSENT_BODY =
  "The entire conversation is copied to the administrator: every message you sent, " +
  "every answer, and the full tool output the assistant worked from. Nothing is sent " +
  "unless you confirm — reporting is the only way any of it reaches an admin.";

export const REPORT_NOTE_PLACEHOLDER = "Optional: what looked wrong?";

/** Mirrors the server bound (`REPORTER_NOTE_MAX`); the server is the enforcer. */
const NOTE_MAX = 1_000;

interface ReportResponse {
  reported: boolean;
  id: number;
  truncation?: { applied: boolean; omittedToolOutputCount: number };
}

interface ReportError extends Error {
  status?: number;
}

export function ReportThreadAction({
  threadId,
  title,
}: {
  threadId: string;
  title: string | null;
}) {
  const label = title ?? "Untitled";
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const { token: csrfToken } = useCSRF();

  const report = useMutation<ReportResponse, ReportError, string>({
    mutationFn: async (reporterNote: string) => {
      const res = await fetch(`/api/assistant/threads/${threadId}/report`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(reporterNote ? { reporterNote } : {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || "Could not report this conversation") as ReportError;
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as ReportResponse;
    },
    onSuccess: (data) => {
      // The reporter is told what actually crossed. A truncated report that reported
      // itself as complete would be the same lie the server refuses to store.
      const omitted = data.truncation?.omittedToolOutputCount ?? 0;
      toast.success(
        data.truncation?.applied
          ? `Conversation sent to the admin — ${omitted} older tool output(s) were too large to include.`
          : "Conversation sent to the admin.",
      );
      setNote("");
    },
    // The SERVER's reason, verbatim: "too many requests" and "too large to report"
    // are different problems and the user can act on the difference.
    onError: (err) => toast.error(err?.message || "Could not report this conversation"),
  });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          data-testid={`thread-report-${threadId}`}
          aria-label={`${REPORT_ACTION_LABEL}: ${label}`}
          title={REPORT_ACTION_LABEL}
          className="absolute right-9 top-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Flag className="h-4 w-4" aria-hidden />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{REPORT_CONSENT_HEADLINE}</AlertDialogTitle>
          <AlertDialogDescription>{REPORT_CONSENT_BODY}</AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          data-testid={`report-note-${threadId}`}
          aria-label="Note for the admin (optional)"
          placeholder={REPORT_NOTE_PLACEHOLDER}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants())}
            onClick={() => report.mutate(note.trim())}
          >
            {REPORT_ACTION_LABEL}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
