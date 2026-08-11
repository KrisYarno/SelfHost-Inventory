"use client";

/**
 * components/admin/usage/usage-range-picker.tsx — the window selector (spec C8:
 * "range picker (default 14 days)").
 *
 * Presets rather than two date inputs: the rollup dimension is a stored UTC dayKey, so
 * a picker that let a browser's local timezone choose the boundary would silently ask
 * for a different window than the one it displayed. The resolved UTC window is always
 * shown next to the presets.
 */

import { Button } from "@/components/ui/button";
import { RANGE_PRESET_DAYS } from "@/hooks/use-assistant-usage";

export function UsageRangePicker({
  days,
  onDaysChange,
  range,
}: {
  days: number;
  onDaysChange: (days: number) => void;
  range: { from: string; to: string };
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex flex-wrap gap-2">
        {RANGE_PRESET_DAYS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={preset === days ? "default" : "outline"}
            aria-pressed={preset === days}
            onClick={() => onDaysChange(preset)}
          >
            {preset} days
          </Button>
        ))}
      </div>
      <p className="text-body-sm text-muted-foreground" data-testid="usage-range-label">
        {range.from} to {range.to} (UTC, inclusive)
      </p>
    </div>
  );
}
