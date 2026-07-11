"use client";

/**
 * components/history/actor-chip.tsx — the metadata-line actor (Lane 3 spec §11
 * D-L5). A USER actor renders as plain text (no badge — the row already carries
 * a batch chip within the 2-badge budget). Non-USER actors (SYSTEM / WEBHOOK /
 * LLM) get the ONE metadata badge with an icon: cog / arrows / sparkle. Lane 4
 * inherits this chip for `actorKind='LLM'` events.
 */

import * as React from "react";
import { Cog, ArrowLeftRight, Sparkles, CircleHelp, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ActionTone } from "@/lib/change-tracking/taxonomy";

type NonUserActor = {
  label: string;
  icon: LucideIcon;
  tone: ActionTone;
};

const NON_USER: Record<string, NonUserActor> = {
  SYSTEM: { label: "System", icon: Cog, tone: "neutral" },
  WEBHOOK: { label: "Webhook", icon: ArrowLeftRight, tone: "info" },
  LLM: { label: "Assistant", icon: Sparkles, tone: "info" },
};

export function ActorChip({
  actorKind,
  actorName,
}: {
  actorKind: string;
  actorName: string | null;
}) {
  if (actorKind === "USER") {
    return <span className="text-muted-foreground">{actorName ?? "Unknown user"}</span>;
  }

  const spec = NON_USER[actorKind] ?? {
    label: actorName ?? actorKind,
    icon: CircleHelp,
    tone: "neutral" as ActionTone,
  };
  const Icon = spec.icon;

  return (
    <StatusBadge tone={spec.tone} className="gap-1">
      <Icon aria-hidden className="h-3 w-3" />
      {actorName ?? spec.label}
    </StatusBadge>
  );
}
