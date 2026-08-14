"use client";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  DEDUCTION_INTENTS,
  INTENT_HINT,
  INTENT_LABEL,
  WORKBENCH_INTENTS,
  type DeductionIntent,
} from "@/lib/inventory/intent";

/**
 * W2-1 (contract pack REV-11 T7 / design REV-2) — the intent chip.
 *
 * ONE question, asked at the only moment anyone can answer it: what was this
 * movement for? The 0a diagnosis found attribution HISTORICALLY ABSENT — stock
 * leaves and nothing records why — and no amount of downstream analysis
 * reconstructs an intent nobody wrote down.
 *
 * THE FRICTION CEILING IS THE FEATURE. This is a skippable one-tap that never
 * gates a submit: the host dialog's Confirm button does not read it, and an
 * untapped chip sends NO value at all, landing server-side as `other`. A
 * required field here would be answered by whichever option is leftmost, and a
 * ledger full of confidently wrong intents is worse than one full of honest
 * nulls — the whole lane exists because a number nobody can stand behind is a
 * liability, not data.
 *
 * SURFACE ASYMMETRY (the `surface` prop): the workbench's manual leg does NOT
 * offer damage-loss ([ADJ] per PLG1-1). That leg books SALE rows, and the
 * shrinkage report only ever looks at ADJUSTMENT/CORRECTION rows — so a
 * damage-loss recorded there would be a loss the loss report can never see. The
 * vocabulary comes from lib/inventory/intent.ts either way, so the component
 * cannot invent an option the request schema would then refuse.
 */

export type IntentChipSurface = "adjust" | "workbench";

interface IntentChipProps {
  surface: IntentChipSurface;
  value: DeductionIntent | null;
  onChange: (value: DeductionIntent) => void;
  disabled?: boolean;
}

/** The group's accessible name — also how tests address the chip specifically. */
export const INTENT_CHIP_GROUP_LABEL = "What was this for?";

export function IntentChip({ surface, value, onChange, disabled }: IntentChipProps) {
  const options: readonly DeductionIntent[] =
    surface === "workbench" ? WORKBENCH_INTENTS : DEDUCTION_INTENTS;

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">
        {INTENT_CHIP_GROUP_LABEL} (optional)
      </Label>
      <RadioGroup
        // The visible Label above is not htmlFor-associated with a radiogroup
        // (there is no single control to point at), so the group carries its own
        // name. Without it a screen reader announces an unnamed set of radios
        // sitting between "Reason" and "Notes".
        aria-label={INTENT_CHIP_GROUP_LABEL}
        // "" (never undefined) for the untapped state: no option carries that
        // value, so nothing renders checked, while the group stays CONTROLLED
        // for its whole lifetime. `undefined` would leave Radix uncontrolled
        // until the first tap and then flip it — React warns about exactly that,
        // and an uncontrolled group would not clear when the host dialog resets.
        value={value ?? ""}
        onValueChange={(next: string) => onChange(next as DeductionIntent)}
        disabled={disabled}
        className="grid gap-1.5"
      >
        {options.map((option) => (
          <div key={option} className="flex items-start gap-2">
            <RadioGroupItem
              value={option}
              id={`intent-${surface}-${option}`}
              aria-label={INTENT_LABEL[option]}
              className="mt-0.5"
            />
            <label
              htmlFor={`intent-${surface}-${option}`}
              className="cursor-pointer leading-tight"
            >
              <span className="text-sm">{INTENT_LABEL[option]}</span>
              <span className="block text-[11px] text-muted-foreground">
                {INTENT_HINT[option]}
              </span>
            </label>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}
