"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Inbox, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * T5 — the positive-delta receiving redirect (pack REV-3, W1-4b).
 *
 * Adding units through a quick adjust or a stock-in produces stock with NO
 * receipt behind it: nothing expected, nothing counted, no discrepancy, and a
 * ledger row with a NULL `inboundShipmentId`. That is the exact hole this lane
 * exists to close, and the cheapest moment to close it is when the operator has
 * just told the UI they are adding units.
 *
 * Three rules, all deliberate:
 *
 *   1. IT NEVER BLOCKS. Declining — or ignoring it entirely — leaves the host
 *      dialog's request byte-for-byte identical. A nudge that can cost someone
 *      their adjustment is a nudge that gets routed around.
 *   2. POSITIVE DELTA ONLY. A removal is not a receipt; neither is a zero.
 *   3. ONCE PER SESSION. The flag is written the FIRST time the prompt renders,
 *      not when it is dismissed, so the answer to "will this thing keep
 *      appearing?" is no regardless of what the operator does with it. A banner
 *      that reappears on every adjustment is one people learn to click past.
 *
 * Session storage (not local) because the point is to catch a receiving SHIFT:
 * tomorrow's boxes deserve the reminder again.
 */

export const RECEIVING_PROMPT_SESSION_KEY = "receiving-redirect-prompt-shown";

/**
 * SSR-safe, exception-safe sessionStorage access (iOS private mode throws on
 * both reads and writes). A storage failure degrades to "show it" — the honest
 * fallback for a purely informational nudge.
 */
function sessionFlagSet(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(RECEIVING_PROMPT_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function markSessionFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RECEIVING_PROMPT_SESSION_KEY, "1");
  } catch {
    // Best-effort only; the prompt simply gets one more chance to appear.
  }
}

interface ReceivingRedirectPromptProps {
  /** The host surface currently describes a POSITIVE stock delta. */
  active: boolean;
  className?: string;
}

export function ReceivingRedirectPrompt({
  active,
  className,
}: ReceivingRedirectPromptProps) {
  // Read the flag ONCE per mount. Reading it on every render would hide the
  // prompt the instant it marked the session — mid-render, in front of the
  // person it was written for.
  const [alreadyShown] = useState(sessionFlagSet);
  const [declined, setDeclined] = useState(false);

  const visible = active && !alreadyShown && !declined;

  useEffect(() => {
    if (visible) markSessionFlag();
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      data-testid="receiving-redirect-prompt"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-surface p-3",
        className
      )}
    >
      <Inbox className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">Receiving a shipment?</p>
        <p className="text-xs text-muted-foreground">
          Entering this as a supply order records what you ordered, what arrived,
          and each labeled stock-in batch — an adjustment records only the
          number.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="secondary">
            <Link href="/receiving">Go to Receiving</Link>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setDeclined(true)}
          >
            No, continue here
          </Button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => setDeclined(true)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
