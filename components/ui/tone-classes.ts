/**
 * The shared semantic tone classes (facelift F1-2). StatusBadge, ValueChip and
 * Badge's warning / success / info variants all read state colour from here.
 * `status-badge.tsx` re-exports both names; `badge.tsx` imports them from this
 * file directly, so the two components never import each other in a circle.
 */
export type StatusTone = "positive" | "negative" | "warning" | "info" | "neutral";

/** Shared semantic tone classes - used by StatusBadge, ValueChip and Badge */
export const toneClasses: Record<StatusTone, string> = {
  positive: "bg-positive-muted text-positive-foreground border border-positive-border",
  negative: "bg-negative-muted text-negative-foreground border border-negative-border",
  warning: "bg-warning-muted text-warning-foreground border border-warning-border",
  info: "bg-info-muted text-info-foreground border border-info-border",
  neutral: "bg-muted text-muted-foreground border border-border",
};
