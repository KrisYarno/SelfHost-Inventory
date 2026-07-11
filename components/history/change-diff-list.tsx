"use client";

/**
 * components/history/change-diff-list.tsx — the core-change-first field diff
 * (Lane 3 spec §11 D-L5). One shared renderer, two scopes (History tab + admin
 * feed).
 *
 * The single most significant field (per the D-L5 field-priority table) is the
 * always-visible primary line; the remaining fields collapse behind a
 * "+N more changes" disclosure (chevron button, `aria-expanded`, whole primary
 * line clickable, collapsed default, 150ms fade, reduced-motion respected).
 * Values render from the redacted payload as-is: `[REDACTED]` shows verbatim in
 * muted mono (it is the truthful value); old values are muted, new values
 * `font-medium`; numerics are `tabular-nums`; from→to uses the `→` glyph.
 */

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActionGroup } from "@/lib/change-tracking/taxonomy";
import type { ChangePair } from "@/lib/change-tracking/extract-changes";
import { orderChanges } from "@/components/history/field-priority";

const REDACTED = "[REDACTED]";

function formatValue(value: unknown): { text: string; redacted: boolean; numeric: boolean } {
  if (value === null || value === undefined) return { text: "—", redacted: false, numeric: false };
  if (typeof value === "string") return { text: value, redacted: value === REDACTED, numeric: false };
  if (typeof value === "number") return { text: String(value), redacted: false, numeric: true };
  if (typeof value === "boolean") return { text: value ? "true" : "false", redacted: false, numeric: false };
  try {
    return { text: JSON.stringify(value), redacted: false, numeric: false };
  } catch {
    return { text: String(value), redacted: false, numeric: false };
  }
}

function DiffValue({ value, emphasis }: { value: unknown; emphasis: "old" | "new" }) {
  const { text, redacted, numeric } = formatValue(value);
  return (
    <span
      className={cn(
        emphasis === "old" ? "text-muted-foreground" : "font-medium text-foreground",
        numeric && "tabular-nums",
        redacted && "font-mono text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}

function ChangeLine({ field, pair }: { field: string; pair: ChangePair }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5 text-sm leading-snug">
      <span className="font-medium text-foreground">{field}</span>
      <DiffValue value={pair.from} emphasis="old" />
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <DiffValue value={pair.to} emphasis="new" />
    </span>
  );
}

export function ChangeDiffList({
  changes,
  entityHint,
}: {
  changes: Record<string, ChangePair>;
  entityHint: ActionGroup;
}) {
  const ordered = React.useMemo(() => orderChanges(changes, entityHint), [changes, entityHint]);
  const [expanded, setExpanded] = React.useState(false);

  if (ordered.length === 0) return null;

  const [coreKey, corePair] = ordered[0];
  const rest = ordered.slice(1);
  const hasMore = rest.length > 0;
  const primary = <ChangeLine field={coreKey} pair={corePair} />;

  if (!hasMore) {
    return <div className="min-w-0">{primary}</div>;
  }

  return (
    <div className="min-w-0 space-y-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {primary}
        {!expanded && (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            +{rest.length} more change{rest.length === 1 ? "" : "s"}
          </span>
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-1 pl-1 duration-150 animate-in fade-in-0 motion-reduce:animate-none motion-reduce:transition-none">
          {rest.map(([key, pair]) => (
            <ChangeLine key={key} field={key} pair={pair} />
          ))}
        </div>
      )}
    </div>
  );
}
