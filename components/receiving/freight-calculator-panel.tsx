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
 * W1S-3 (W1-C fix round) — THE FLOOR IS A CHOICE, NEVER A DEFAULT. A suggested
 * unit cost is `base + FLOOR(allocated / qty)`, so when the division is not
 * exact the line's true landed total is `qty * unit + remainder` and writing the
 * unit cost alone drops that remainder. Showing it was not enough: Accept wrote
 * the line regardless, and the money disappeared from the valuation with nobody
 * having agreed to lose it. So an inexact line is WITHHELD, and there are
 * exactly two ways out — edit the split until it divides, or press this line's
 * "write floored" and take the drop deliberately, with the cents named.
 *
 * FD-1 (fix round 2) — THE BILL IS A SESSION. W1S-5 kept the bill on screen
 * after a failed write, but the panel's inputs are the shipment's LIVE rows and
 * a successful write refreshes them: a line that had just been written came
 * back with its landed cost as a new BASE, the same freight was split again over
 * the new values, and the retry re-sent it at a higher number still (100c ->
 * 200c -> 333c). So Allocate FREEZES the bill's inputs, nothing is ever
 * recomputed mid-session, and a row that moves underneath an open bill
 * invalidates the whole bill by name instead of quietly re-basing it.
 *
 * FD2-2 (fix round 3) — THE DRIFT CHECK IS THE SERVER'S. Everything compared
 * here is a render old, so every line carries `ifUnitCostCents` — the value it
 * expects the row to still hold — and the server makes that its WHERE. A refusal
 * arrives as the API error's `code: "COST_DRIFT"` and invalidates the whole bill
 * through the same surface a locally-detected change uses.
 *
 * FD3-1 (fix round 4) — THE PARTIAL WRITE IS GONE, AND SO IS EVERY STATE THAT
 * DESCRIBED ONE. Accept used to fan out into one request per line, and three
 * review rounds running found a new way for a half-landed bill to hurt somebody.
 * The last was the sharpest: after a partial commit the panel's own recovery
 * ("clear and re-enter the FULL freight") re-allocated the whole invoice
 * including onto bases that had already absorbed their share. The caller now
 * writes the WHOLE bill in one transaction, so there are exactly two outcomes:
 * everything wrote, or nothing did. `written` / `writtenIds` / `totalLocked`,
 * the restated lines, the "already written" row badge and SEAM S12 (the
 * `PartialAllocationWriteError` carrying `writtenLineIds` + `kind`) are all
 * DELETED — there is no partial state left for them to describe. A failure keeps
 * the bill exactly as it is and Accept-again re-sends it whole, which is safe
 * precisely because nothing landed.
 *
 * Accept hands back the per-line unit costs; writing them ATOMICALLY is the
 * caller's job. A caller whose write fails must REJECT (W1S-5).
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

/** One line's write: the cost to set, and the cost it must still hold (FD2-2). */
export interface AllocationWrite {
  id: number;
  unitCostCents: number;
  /** The precondition. NULL is legal and means "still unpriced". */
  ifUnitCostCents: number | null;
}

/** The frozen inputs of one bill: what the split was computed from. */
interface BillSession {
  freightCents: number;
  lines: CalculatorLine[];
}

interface FreightCalculatorPanelProps {
  lines: CalculatorLine[];
  onAccept: (updates: AllocationWrite[]) => void | Promise<void>;
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

/**
 * Did the SERVER refuse a cost precondition (FD2-2)? Read off the API error's
 * house `code`, defensively — the panel takes no dependency on the caller's
 * error class, only on the field the server itself sent.
 */
function isCostDrift(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "COST_DRIFT";
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
  // The frozen bill. NULL until Allocate is pressed: nothing is computed from
  // rows that are still moving.
  const [session, setSession] = useState<BillSession | null>(null);
  // Hand edits, keyed by line id, as typed. Absent = "use the suggestion".
  const [edits, setEdits] = useState<Record<number, string>>({});
  // Set once a bill has been written onto the lines this session.
  const [applied, setApplied] = useState(false);
  /**
   * The floored drops this operator has agreed to (W1S-3), keyed by line id and
   * by the AMOUNTS they were agreed for (FD-4). A bare `true` outlived the edit
   * that changed what the line would lose, so somebody who accepted a 2c drop
   * could be held to a 3c one; matching on the amounts sends the line straight
   * back to withheld the moment either number moves. Editing back to the
   * original split restores the consent, because the sentence it stands for
   * ("drop THESE cents on THIS line") is true again.
   */
  const [flooredConsent, setFlooredConsent] = useState<
    Record<number, { unitCostCents: number; remainderCents: number }>
  >({});
  // Set when the caller's write REJECTED, so the panel never resets on a failure.
  const [writeFailed, setWriteFailed] = useState<string | null>(null);
  /**
   * The SERVER's drift refusal (FD2-2), rendered through the same invalidation
   * surface a locally-detected change uses. Its own state because it survives a
   * refetch: the rows may look perfectly consistent by the time it lands, and
   * the bill is dead anyway.
   */
  const [driftInvalidation, setDriftInvalidation] = useState<string | null>(null);
  /**
   * The bill is OUT and its outcome is unknown (FD2-3). While that is true it may
   * not be thrown away or re-entered underneath the request that is deciding it.
   */
  const [accepting, setAccepting] = useState(false);

  const freightCents = parseDollarsToCents(freightInput);
  const freightInvalid = freightInput.trim() !== "" && freightCents === null;

  /** Wipe the bill entirely — the only way back from an invalidated session. */
  const clearBill = () => {
    setFreightInput("");
    setSession(null);
    setEdits({});
    setFlooredConsent({});
    setWriteFailed(null);
    setDriftInvalidation(null);
    setApplied(false);
  };

  /**
   * Has the shipment moved underneath the frozen bill?
   *
   * FD3-1 simplified this back to what it says: ANY difference between the frozen
   * line and the live one (a cost changed elsewhere, a recount, a line unlinked)
   * means the split on screen no longer describes this shipment, and the honest
   * answer is to throw the whole bill away rather than re-base part of it. The
   * old "unless it was OUR write" exemption is gone with the partial write it
   * existed for — a successful bill clears the session before its refetch lands,
   * and a failed one wrote nothing at all.
   */
  const localInvalidation = useMemo<string | null>(() => {
    if (!session) return null;
    const live = new Map(lines.map((line) => [line.id, line]));
    for (const snapshot of session.lines) {
      const now = live.get(snapshot.id);
      if (!now) {
        return `Line "${snapshot.description}" is no longer on this shipment.`;
      }
      if (now.baseCents !== snapshot.baseCents) {
        return `The cost of "${snapshot.description}" changed while this bill was open.`;
      }
      if (now.qty !== snapshot.qty) {
        return `The quantity of "${snapshot.description}" changed while this bill was open, and the split rests on it.`;
      }
    }
    return null;
  }, [session, lines]);

  /**
   * The one invalidation the panel renders. The SERVER's verdict wins: it is the
   * only one that saw the rows at the moment of the write.
   */
  const invalidation = driftInvalidation ?? localInvalidation;

  /** The bill is computable: frozen, and still describing this shipment. */
  const active = session !== null && invalidation === null;

  const freightLines: FreightLine[] = useMemo(
    () =>
      session
        ? session.lines.map((l) => ({ id: l.id, qty: l.qty, baseCents: l.baseCents }))
        : [],
    [session],
  );

  // The module can THROW on a caller contract violation (duplicate ids, a
  // fractional cost that reached us from somewhere unexpected). That is a bug,
  // not a user state — but a receiving screen that white-screens mid-shift is
  // worse than one that says what went wrong, so it is caught and rendered.
  const outcome = useMemo<
    { kind: "result"; result: AllocationResult } | { kind: "error"; message: string } | null
  >(() => {
    if (!session || !active) return null;
    try {
      return {
        kind: "result",
        result: allocateFreight(freightLines, session.freightCents),
      };
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : "Allocation failed",
      };
    }
  }, [session, active, freightLines]);

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
    if (!ok || !edited || !session) return null;
    return validateEditedAllocations(
      currentAllocations.map((a) => ({ id: a.id, allocatedCents: a.allocatedCents })),
      session.freightCents,
    );
  }, [ok, edited, currentAllocations, session]);

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

  /** Lines that CAN be priced at all — the rest have no base to build on. */
  const priceable = suggestions.filter(
    (s): s is typeof s & { suggestedUnitCostCents: number } =>
      s.suggestedUnitCostCents !== null,
  );

  /** FD-4: consent counts only for the exact amounts it was given for. */
  const consented = (s: (typeof priceable)[number]) => {
    const agreed = flooredConsent[s.id as number];
    return (
      agreed !== undefined &&
      agreed.unitCostCents === s.suggestedUnitCostCents &&
      agreed.remainderCents === s.unitRoundingRemainderCents
    );
  };

  /**
   * The W1S-3 split. A line is written when its allocation divides exactly
   * across its units, or when this operator has said out loud that the drop is
   * acceptable for this line. Everything else is held back — visibly.
   */
  const writable = priceable.filter(
    (s) => s.unitRoundingRemainderCents === 0 || consented(s),
  );
  const withheld = priceable.filter(
    (s) => s.unitRoundingRemainderCents > 0 && !consented(s),
  );

  const canAllocate =
    !disabled && !busy && !accepting &&
    freightCents !== null && lines.length > 0 && invalidation === null;

  const canAccept =
    !disabled &&
    !busy &&
    !accepting &&
    active &&
    ok !== null &&
    (validation === null || validation.status === "ok") &&
    writable.length > 0;

  /**
   * What a press of Accept SENDS: the WHOLE bill (FD3-1) — every writable line
   * at its frozen allocation, each guarded on the base the split was computed
   * from (FD2-2). Withheld lines stay out (W1S-3: an inexact split is not
   * consented to), and there is no "already written" category to subtract,
   * because the caller writes all of these or none of them.
   */
  const buildPayload = (): AllocationWrite[] => {
    if (!session) return [];
    const frozenBase = new Map(session.lines.map((line) => [line.id, line.baseCents]));
    return writable.map((s) => ({
      id: s.id as number,
      unitCostCents: s.suggestedUnitCostCents,
      ifUnitCostCents: frozenBase.get(s.id as number) ?? null,
    }));
  };

  const handleAllocate = () => {
    if (!canAllocate || freightCents === null) return;
    // THE FREEZE. Everything downstream reads this snapshot, so a refetch can
    // change what the screen COMPARES against but never what it computed.
    setSession({ freightCents, lines });
    setEdits({});
    setFlooredConsent({});
    setWriteFailed(null);
    setApplied(false);
  };

  const handleAccept = async () => {
    if (!canAccept) return;
    const payload = buildPayload();
    setAccepting(true);
    try {
      await onAccept(payload);
    } catch (error) {
      // W1S-5 / FD3-1: the bill did not land — NONE of it — so nothing here may
      // look like it did. The bill, the edits and the per-line choices all stay
      // exactly as they were, and Accept-again re-sends the same request.
      if (isCostDrift(error)) {
        // FD2-2: the server refused a precondition, so the shipment is not the
        // one this split describes — and no amount of retrying makes it so. The
        // WHOLE bill goes, by name, through the same surface a locally-detected
        // change uses. Safe advice now that it is also TRUE advice: nothing was
        // written, so re-entering the full freight cannot double-apply it.
        setDriftInvalidation(
          error instanceof Error
            ? `A line's cost changed while this bill was open (${error.message}).`
            : "A line's cost changed while this bill was open.",
        );
        setWriteFailed(null);
      } else {
        setWriteFailed(
          error instanceof Error ? error.message : "The costs were not written.",
        );
      }
      setApplied(false);
      return;
    } finally {
      setAccepting(false);
    }
    // THE COMPOUNDING GUARD. Accepting rewrites each line's base cost to
    // base + freight — so leaving the bill in the box and pressing Accept again
    // would allocate the same freight ON TOP of itself, quietly inflating the
    // valuation of real stock. The form resets and says why; entering a second
    // bill has to be a deliberate act.
    clearBill();
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
        go one apiece to the largest remainders and are shown per line. Allocate
        freezes the costs it splits, so a line saved elsewhere mid-bill cannot
        quietly change the answer.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5 sm:max-w-[220px]">
          <Label htmlFor="freight-total">Freight / fees total</Label>
          <Input
            id="freight-total"
            inputMode="decimal"
            value={freightInput}
            onChange={(e) => {
              // A different total is a different bill: the frozen one goes.
              setFreightInput(e.target.value);
              setSession(null);
              setEdits({});
              setFlooredConsent({});
              setApplied(false);
              setWriteFailed(null);
            }}
            placeholder="0.00"
            disabled={disabled || accepting}
          />
        </div>
        <Button type="button" variant="secondary" onClick={handleAllocate} disabled={!canAllocate}>
          Allocate
        </Button>
      </div>
      {freightInvalid && (
        <p data-testid="allocation-input-error" className="text-xs text-destructive">
          Enter a non-negative amount in dollars.
        </p>
      )}

      {applied && (
        <p data-testid="allocation-applied" className="text-xs text-muted-foreground">
          Costs written. Each line&apos;s base cost now INCLUDES that freight, so
          entering the same bill again would allocate it on top of itself.
        </p>
      )}

      {writeFailed && (
        <p
          data-testid="allocation-write-failed"
          className="text-xs font-medium text-destructive"
        >
          {`These costs were not written (${writeFailed}). The whole bill is written at once, so NOTHING landed — the bill and your edits are kept, and Accept again re-sends it unchanged.`}
        </p>
      )}

      {invalidation && (
        <div
          data-testid="allocation-invalidated"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1"
        >
          <p className="text-sm font-medium">Costs changed — re-enter the bill.</p>
          <p className="text-xs text-muted-foreground">
            {`${invalidation} This bill was split across the costs as they were, so it is no longer the right answer. Clear it and enter the freight again against the costs on screen.`}
          </p>
        </div>
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

      {ok && session && (
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
                {session.lines.map((line, index) => {
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
                            {/* W1S-3: the two ways an inexact line leaves this
                                state — edit the split, or take the drop. FD-4:
                                the consent below is read back at the CURRENT
                                amounts, so an edit revokes it. */}
                            {suggestion.unitRoundingRemainderCents > 0 &&
                              (consented(
                                suggestion as (typeof priceable)[number],
                              ) ? (
                                <span
                                  data-testid="floored-accepted"
                                  className="block text-xs text-amber-700 dark:text-amber-400"
                                >
                                  {`Writing the floored cost — ${suggestion.unitRoundingRemainderCents}¢ of this line's freight is dropped.`}
                                </span>
                              ) : (
                                <span className="block space-y-1">
                                  <span
                                    data-testid="needs-exact-split"
                                    className="block text-xs text-amber-700 dark:text-amber-400"
                                  >
                                    Needs an exact split — not written. Edit the
                                    allocation until it divides by the quantity.
                                  </span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7"
                                    onClick={() =>
                                      setFlooredConsent((prev) => ({
                                        ...prev,
                                        [line.id]: {
                                          unitCostCents:
                                            suggestion.suggestedUnitCostCents as number,
                                          remainderCents:
                                            suggestion.unitRoundingRemainderCents,
                                        },
                                      }))
                                    }
                                    disabled={disabled || busy}
                                  >
                                    {`Write floored (drops ${suggestion.unitRoundingRemainderCents}¢)`}
                                  </Button>
                                </span>
                              ))}
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
        {session !== null && (
          // FD2-3: offered whenever there is a bill to throw away. It needs no
          // token and no permission, and an invalidated bill has no other exit;
          // the ONE moment it is refused is while a write is in flight, because a
          // late rejection would otherwise repopulate a bill somebody just
          // cleared.
          <Button
            type="button"
            variant="outline"
            onClick={clearBill}
            disabled={accepting}
          >
            Clear the bill
          </Button>
        )}
        {ok && session && priceable.length < session.lines.length && (
          <span className="text-xs text-muted-foreground">
            {`${session.lines.length - priceable.length} line(s) have no base cost and will be left unpriced.`}
          </span>
        )}
        {ok && withheld.length > 0 && (
          <span data-testid="allocation-withheld" className="text-xs text-amber-700 dark:text-amber-400">
            {`${withheld.length} line(s) cannot be expressed as a whole unit cost and are held back. Accept writes the rest.`}
          </span>
        )}
      </div>
    </div>
  );
}
