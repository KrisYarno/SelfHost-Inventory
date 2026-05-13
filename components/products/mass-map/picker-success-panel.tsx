"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  parentTitle: string;
  variantTitle: string | null;
  internalProductName: string;
  onFinish: () => void;
  onKeep: () => void;
  autoKeepAfterMs?: number;
}

export function PickerSuccessPanel({
  parentTitle,
  variantTitle,
  internalProductName,
  onFinish,
  onKeep,
  autoKeepAfterMs = 8000,
}: Props) {
  const [remainingMs, setRemainingMs] = useState(autoKeepAfterMs);

  // Stable ref so the timer effect doesn't restart when the parent passes a
  // fresh callback identity on every render (common React footgun).
  const onKeepRef = useRef(onKeep);
  useEffect(() => {
    onKeepRef.current = onKeep;
  }, [onKeep]);

  useEffect(() => {
    setRemainingMs(autoKeepAfterMs);
    const start = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      const left = Math.max(0, autoKeepAfterMs - elapsed);
      setRemainingMs(left);
      if (left === 0) {
        clearInterval(tick);
        onKeepRef.current();
      }
    }, 250);
    return () => clearInterval(tick);
  }, [autoKeepAfterMs, parentTitle, variantTitle]);

  return (
    <div className="rounded-lg border border-green-600/50 bg-green-500/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-green-700 dark:text-green-300 mb-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-background">
          <Check className="h-3.5 w-3.5" />
        </span>
        Mapped successfully
      </div>
      <div className="pl-7 text-xs text-muted-foreground mb-4">
        <strong className="text-foreground">
          {parentTitle}
          {variantTitle ? ` / ${variantTitle}` : ""}
        </strong>
        <br />
        → <strong className="text-foreground">{internalProductName}</strong>
      </div>
      <div className="flex gap-2">
        <Button onClick={onKeep} className="flex-1">
          Keep mapping →
        </Button>
        <Button variant="outline" onClick={onFinish}>
          Finished mapping
        </Button>
      </div>
      <p className="mt-2 text-center text-[10px] text-muted-foreground">
        Auto-continues in {Math.ceil(remainingMs / 1000)}s…
      </p>
    </div>
  );
}
