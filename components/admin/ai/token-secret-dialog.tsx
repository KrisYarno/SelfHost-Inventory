"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const SECRET_ONCE_COPY = "Copy this token now. It will not be shown again.";

interface TokenSecretDialogProps {
  token: string | null;
  tokenName?: string;
  onClose: () => void;
}

/**
 * The once-only API-token secret (D-B9): AlertDialog — modal, no outside-click
 * dismissal (the secret can't be lost). Selectable mono token + 44px Copy +
 * "Copy this token now. It will not be shown again." Closing clears the
 * plaintext from state (the parent nulls `token`). The token NEVER enters a
 * toast — only the "Token copied" confirmation does.
 */
export function TokenSecretDialog({ token, tokenName, onClose }: TokenSecretDialogProps) {
  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast.success("Token copied");
    } catch {
      toast.error("Could not copy — select the token and copy manually");
    }
  };

  return (
    <AlertDialog
      open={!!token}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tokenName ? `Token for ${tokenName}` : "New API token"}
          </AlertDialogTitle>
          <AlertDialogDescription>{SECRET_ONCE_COPY}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 rounded-md border border-border bg-muted p-3">
          <code className="flex-1 select-all break-all font-mono text-sm text-foreground">
            {token}
          </code>
          <button
            type="button"
            onClick={copy}
            aria-label="Copy token"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>

        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>Done</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
