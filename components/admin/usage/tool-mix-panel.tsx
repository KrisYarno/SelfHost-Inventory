"use client";

/**
 * components/admin/usage/tool-mix-panel.tsx — which assistant tools actually ran in
 * the window (spec C8).
 *
 * `assistant_runs` prunes at 10k rows while request rollups are kept forever, so this
 * is the ONE clipped figure on the page — the horizon note ships with it on every
 * render, empty mix included, because "no tool calls" and "tool calls aged out" must
 * not be confusable.
 */

import { TOOL_MIX_DEFINITION, EMPTY_TOOL_MIX_REASON } from "./usage-definitions";
import type { AssistantUsageToolMixEntry } from "@/hooks/use-assistant-usage";

export function ToolMixPanel({
  toolMix,
  horizonNote,
}: {
  toolMix: AssistantUsageToolMixEntry[];
  horizonNote: string;
}) {
  return (
    <div className="space-y-3 p-4 sm:p-6">
      <h2 className="text-h4">Tool mix</h2>

      {toolMix.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{EMPTY_TOOL_MIX_REASON}</p>
      ) : (
        <ul className="divide-y divide-border">
          {toolMix.map((entry) => (
            <li key={entry.toolName} className="flex items-center justify-between gap-4 py-2">
              <span className="min-w-0 truncate text-body-sm">{entry.toolName}</span>
              <span className="tabular-nums text-body-sm">{entry.calls}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-body-sm text-muted-foreground">{TOOL_MIX_DEFINITION}</p>
      <p className="text-body-sm text-muted-foreground">{horizonNote}</p>
    </div>
  );
}
