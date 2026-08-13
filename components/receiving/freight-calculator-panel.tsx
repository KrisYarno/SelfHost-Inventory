"use client";

import { useMemo, useState } from "react";
import { Calculator, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  allocateFreight,
  suggestedUnitCosts,
  validateEditedAllocations,
  type AllocationResult,
  type EditedAllocationValidation,
  type FreightLine,
  type LineAllocation,
} from "@/lib/shipments/cost-allocation";

/**
 * The freight/fee calculator, mounted on lib/shipments/cost-allocation.ts
 * (pack REV-3 T3; W1-4a owns every number below).
 *
 * This panel deliberately adds NO arithmetic of its own. Its whole job is to
 * show what the module returned without softening it:
 *
 *   - a REFUSAL is rendered with its named reason. The module refuses when
 *     there is no value to allocate against, and inventing a split there would
 *     be a number nobody could stand behind;
 *   - every DISCLOSURE is printed, including the boring ones;
 *   - the per-line ROUNDING DELTA is a column, because two identical lines that
 *     differ by a penny need that penny explained on screen;
 *   - a line with no base cost suggests NOTHING with its reason — never $0.00,
 *     which would read as "this product is free";
 *   - EDITS are re-validated against the total before Accept unlocks.
 *
 * Accept hands back the per-line unit costs; writing them is the caller's job.
 */

export interface CalculatorLine {
  id: number;
  description: string;
  /** Units the cost is spread over. */
  qty: number;
  /** Which quantity `qty` came from — shown, so the split is auditable. */
  qtySource: "counted" | "expected" | "none";
  /** Per-unit base cost in cents; NULL when the line has not been priced. */
  baseCents: number | null;
}

interface FreightCalculatorPanelProps {
  lines: CalculatorLine[];
  onAccept: (
    updates: Array<{ id: number; unitCostCents: number }>,
  ) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
}

/** INT cents -> money. NULL is "not priced", never $0.00 (truthful-data). */
function formatCents(cents: number | null): string {
  if (cents === null) return "Not priced";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Dollars typed by a human -> whole cents. Returns `null` for anything that is
 * not a non-negative amount, so the calculator is never CALLED with input it
 * would throw on (its throws are for programmer errors, not typos).
 */
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

const QTY_SOURCE_LABEL: Record<CalculatorLine["qtySource"], string> = {
  counted: "counted",
  expected: "expected",
  none: "no quantity",
};

export function FreightCalculatorPanel({
  lines,
  onAccept,
  disabled = false,
  busy = false,
}: FreightCalculatorPanelProps) {
  const [freightInput, setFreightInput] = useState("");
  // Hand edits, keyed by line id, as typed. Absent = "use the suggestion".
  const [edits, setEdits] = useState<Record<number, string>>({});
  // Set once a bill has been written onto the lines this session.
  const [applied, setApplied] = useState(false);

  const freightCents = parseDollarsToCents(freightInput);
  const freightInvalid = freightInput.trim() !== "" && freightCents === null;

  const freightLines: FreightLine[] = useMemo(
    () => lines.map((l) => ({ id: l.id, qty: l.qty, baseCents: l.baseCents })),
    [lines],
  );

  // The module can THROW on a caller contract violation (duplicate ids, a
  // fractional cost that reached us from somewhere unexpected). That is a bug,
  // not a user state — but a receiving screen that white-screens mid-shift is
  // worse than one that says what went wrong, so it is caught and rendered.
  const outcome = useMemo<
    { kind: "result"; result: AllocationResult } | { kind: "error"; message: string } | null
  >(() => {
    if (freightCents === null || lines.length === 0) return null;
    try {
      return { kind: "result", result: allocateFreight(freightLines, freightCents) };
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : "Allocation failed",
      };
    }
  }, [freightCents, freightLines, lines.length]);

  const ok =
    outcome?.kind === "result" && outcome.result.status === "ok" ? outcome.result : null;

  /** The allocation actually on screen: the suggestion, or the hand edit. */
  const currentAllocations: LineAllocation[] = useMemo(() => {
    if (!ok) return [];
    return ok.allocations.map((allocation) => {
      const edited = edits[allocation.id as number];
      if (edited === undefined) return allocation;
      const parsed = Number(edited.trim());
      return {
        ...allocation,
        allocatedCents: Number.isFinite(parsed) ? parsed : NaN,
      };
    });
  }, [ok, edits]);

  const edited = Object.keys(edits).length > 0;

  const validation: EditedAllocationValidation | null = useMemo(() => {
    if (!ok || !edited || freightCents === null) return null;
    return validateEditedAllocations(
      currentAllocations.map((a) => ({ id: a.id, allocatedCents: a.allocatedCents })),
      freightCents,
    );
  }, [ok, edited, currentAllocations, freightCents]);

  // Unit costs are derived from what is ON SCREEN, so the suggestion column and
  // the Accept payload can never disagree. Invalid edits make them unaskable.
  const suggestions = useMemo(() => {
    if (!ok) return [];
    if (validation && validation.status !== "ok") return [];
    try {
      return suggestedUnitCosts(freightLines, currentAllocations);
    } catch {
      return [];
    }
  }, [ok, validation, freightLines, currentAllocations]);

  const acceptable = suggestions.filter(
    (s): s is typeof s & { suggestedUnitCostCents: number } =>
      s.suggestedUnitCostCents !== null,
  );

  const canAccept =
    !disabled &&
    !busy &&
    ok !== null &&
    (validation === null || validation.status === "ok") &&
    acceptable.length > 0;

  const handleAccept = async () => {
    if (!canAccept) return;
    await onAccept(
      acceptable.map((s) => ({
        id: s.id as number,
        unitCostCents: s.suggestedUnitCostCents,
      })),
    );
    // THE COMPOUNDING GUARD. Accepting rewrites each line's base cost to
    // base + freight — so leaving the bill in the box and pressing Accept again
    // would allocate the same freight ON TOP of itself, quietly inflating the
    // valuation of real stock. The form resets and says why; entering a second
    // bill has to be a deliberate act.
    setFreightInput("");
    setEdits({});
    setApplied(true);
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Calculator className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Freight &amp; fees</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        The bill is split across the lines by what each one is WORTH (quantity x
        base cost), not by line count. Every cent is accounted for: the leftovers
        go one apiece to the largest remainders and are shown per line.
      </p>

      <div className="space-y-1.5 sm:max-w-[220px]">
        <Label htmlFor="freight-total">Freight / fees total</Label>
        <Input
          id="freight-total"
          inputMode="decimal"
          value={freightInput}
          onChange={(e) => {
            setFreightInput(e.target.value);
            setEdits({});
            setApplied(false);
          }}
          placeholder="0.00"
          disabled={disabled}
        />
        {freightInvalid && (
          <p data-testid="allocation-input-error" className="text-xs text-destructive">
            Enter a non-negative amount in dollars.
          </p>
        )}
      </div>

      {applied && (
        <p data-testid="allocation-applied" className="text-xs text-muted-foreground">
          Costs written. Each line&apos;s base cost now INCLUDES that freight, so
          entering the same bill again would allocate it on top of itself.
        </p>
      )}

      {lines.length === 0 && (
        <p data-testid="allocation-empty" className="text-sm text-muted-foreground">
          This shipment has no lines to allocate against yet. Link a received box
          to it first.
        </p>
      )}

      {outcome?.kind === "error" && (
        <p data-testid="allocation-error" className="text-sm text-destructive">
          {outcome.message}
        </p>
      )}

      {outcome?.kind === "result" && outcome.result.status === "refused" && (
        <div
          data-testid="allocation-refused"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1"
        >
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            Freight was not allocated ({outcome.result.reason})
          </p>
          {outcome.result.disclosures.map((disclosure) => (
            <p key={disclosure} className="text-xs text-amber-700 dark:text-amber-300">
              {disclosure}
            </p>
          ))}
        </div>
      )}

      {ok && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Line</th>
                  <th className="py-1 pr-2 font-medium text-right">Qty</th>
                  <th className="py-1 pr-2 font-medium text-right">Base</th>
                  <th className="py-1 pr-2 font-medium text-right">Allocated (¢)</th>
                  <th className="py-1 pr-2 font-medium text-right">Residual</th>
                  <th className="py-1 font-medium text-right">Suggested unit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const allocation = ok.allocations[index];
                  const suggestion = suggestions.find((s) => s.id === line.id);
                  return (
                    <tr
                      key={line.id}
                      data-testid={`allocation-row-${line.id}`}
                      className="border-t border-border/60"
                    >
                      <td className="py-2 pr-2">
                        <span className="font-medium">{line.description}</span>
                        <span className="block text-xs text-muted-foreground">
                          {QTY_SOURCE_LABEL[line.qtySource]}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{line.qty}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {formatCents(line.baseCents)}
                      </td>
                      <td className="py-2 pr-2 text-right">
                        <Label
                          htmlFor={`allocated-${line.id}`}
                          className="sr-only"
                        >
                          Allocated cents for {line.description}
                        </Label>
                        <Input
                          id={`allocated-${line.id}`}
                          type="number"
                          className="h-8 w-24 text-right tabular-nums"
                          value={
                            edits[line.id] ?? String(allocation?.allocatedCents ?? 0)
                          }
                          onChange={(e) =>
                            setEdits((prev) => ({ ...prev, [line.id]: e.target.value }))
                          }
                          disabled={disabled}
                        />
                      </td>
                      <td
                        data-testid="rounding-delta"
                        className="py-2 pr-2 text-right tabular-nums text-xs text-muted-foreground"
                      >
                        {allocation && allocation.roundingDeltaCents > 0
                          ? `+${allocation.roundingDeltaCents}`
                          : "—"}
                      </td>
                      <td
                        data-testid="suggested-unit-cost"
                        className="py-2 text-right tabular-nums"
                      >
                        {suggestion === undefined ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : suggestion.suggestedUnitCostCents === null ? (
                          <span className="text-xs text-muted-foreground">
                            No suggestion (no base cost)
                          </span>
                        ) : (
                          <>
                            {formatCents(suggestion.suggestedUnitCostCents)}
                            {suggestion.unitRoundingRemainderCents > 0 && (
                              <span
                                data-testid="unit-remainder"
                                className="block text-xs text-muted-foreground"
                              >
                                {`+${suggestion.unitRoundingRemainderCents}¢ no unit cost can express`}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {validation && (
            <p
              data-testid="allocation-validation"
              className={cn(
                "text-xs",
                validation.status === "ok" ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {validation.status === "ok"
                ? `Your edits add up to the freight total (${validation.totalCents}¢).`
                : `Edits rejected (${validation.reason})` +
                  (validation.differenceCents === null
                    ? "."
                    : `: they are ${validation.differenceCents}¢ off the total.`)}
            </p>
          )}

          <div
            data-testid="allocation-disclosures"
            className="flex gap-2 rounded-md border border-border/60 p-2"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              {ok.disclosures.map((disclosure) => (
                <p key={disclosure} className="text-xs text-muted-foreground">
                  {disclosure}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={handleAccept} disabled={!canAccept}>
          {busy ? "Saving…" : "Accept suggested costs"}
        </Button>
        {ok && acceptable.length < lines.length && (
          <span className="text-xs text-muted-foreground">
            {`${lines.length - acceptable.length} line(s) have no base cost and will be left unpriced.`}
          </span>
        )}
      </div>
    </div>
  );
}
