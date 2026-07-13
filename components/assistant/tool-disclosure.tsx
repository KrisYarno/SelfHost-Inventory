"use client";

/**
 * components/assistant/tool-disclosure.tsx — a single tool call's lifecycle row
 * (spec §12 D-B3). Reuses the ChangeDiffList disclosure motif (NOT the stock
 * Accordion — it lacks aria-expanded and runs 300ms).
 *
 * Three lifecycle states:
 *   - pending   : humanized pendingLabel + one motion-reduce-safe spinner;
 *   - success   : humanized successLabel + phrase-form args summary, an
 *                 expandable ToolResultTable, and truthfulness meta chips
 *                 (scope; `Trimmed` on truncation);
 *   - error     : a contained negative row that never erases prior content.
 *
 * Copy comes ONLY from TOOL_PRESENTATION (client-safe) — raw tool names and JSON
 * never reach the UI. The disclosure button is a real 44px target with
 * aria-expanded + aria-controls; the body fades in 150ms (reduced-motion safe).
 */

import * as React from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/status-badge";
import { TOOL_PRESENTATION, type ToolPresentation } from "@/lib/assistant/tool-presentation";
import { ToolResultTable, resultIsEmpty } from "@/components/assistant/tool-result-table";

export type ToolDisclosureStatus = "pending" | "success" | "error" | "truncated";

export interface ToolInvocationView {
  /** Raw tool name — used ONLY to look up presentation copy, never rendered. */
  name: string;
  status: ToolDisclosureStatus;
  /** The call arguments (user-derived); summarized, never shown as JSON. */
  input: unknown;
  /** Successful result payload (the ToolResult.data). */
  data?: unknown;
  /** Result scope, for the truthfulness chip. */
  scope?: "company" | "global";
  /** dataStart, relayed verbatim where a tool provides it. */
  dataStart?: string | null;
}

const FALLBACK: ToolPresentation = {
  pendingLabel: "Working…",
  successLabel: "Done",
  failureNoun: "data",
  emptyCopy: "No results.",
  summarizeArgs: () => "",
};

function presentationFor(name: string): ToolPresentation {
  return TOOL_PRESENTATION[name] ?? FALLBACK;
}

function ScopeChip({ scope }: { scope: "company" | "global" }) {
  return (
    <StatusBadge tone="neutral">
      {scope === "global" ? "All companies" : "Your companies"}
    </StatusBadge>
  );
}

export function ToolDisclosure({ tool }: { tool: ToolInvocationView }) {
  const bodyId = React.useId();
  const [expanded, setExpanded] = React.useState(false);
  const p = presentationFor(tool.name);
  const phrase = p.summarizeArgs(tool.input);

  // --- pending ------------------------------------------------------------
  if (tool.status === "pending") {
    return (
      <div className="flex min-h-[44px] items-center gap-2 py-1 text-body-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        <span>{p.pendingLabel}</span>
      </div>
    );
  }

  // --- error --------------------------------------------------------------
  if (tool.status === "error") {
    return (
      <div className="flex min-h-[44px] items-center gap-2 py-1 text-body-sm">
        <StatusBadge tone="negative">Couldn&rsquo;t read {p.failureNoun}</StatusBadge>
      </div>
    );
  }

  // --- truncated (label + Trimmed warning; no expandable table) -----------
  if (tool.status === "truncated") {
    return (
      <div className="flex min-h-[44px] flex-wrap items-center gap-2 py-1 text-body-sm">
        <span className="text-foreground">{p.successLabel}</span>
        {phrase && <span className="text-muted-foreground">{phrase}</span>}
        <StatusBadge tone="warning">Trimmed</StatusBadge>
        {tool.scope && <ScopeChip scope={tool.scope} />}
      </div>
    );
  }

  // --- success ------------------------------------------------------------
  const empty = resultIsEmpty(tool.data);

  return (
    <div className="py-1">
      <div className="flex flex-wrap items-center gap-2">
        {empty ? (
          <span className="flex min-h-[44px] items-center text-body-sm text-foreground">
            {p.successLabel}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={bodyId}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md pr-2 text-left text-body-sm text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
              aria-hidden
            />
            <span>{p.successLabel}</span>
          </button>
        )}
        {phrase && <span className="text-body-sm text-muted-foreground">{phrase}</span>}
        {tool.scope && <ScopeChip scope={tool.scope} />}
        {tool.dataStart && (
          <span className="text-caption text-muted-foreground">since {tool.dataStart}</span>
        )}
      </div>

      {empty ? (
        <p className="mt-1 text-body-sm text-muted-foreground">{p.emptyCopy}</p>
      ) : (
        expanded && (
          <div
            id={bodyId}
            className="mt-2 animate-fade-in motion-reduce:animate-none"
          >
            <ToolResultTable data={tool.data} />
          </div>
        )
      )}
    </div>
  );
}
