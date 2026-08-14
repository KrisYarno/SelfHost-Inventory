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
 * after a partial write, but the panel's inputs are the shipment's LIVE rows and
 * every successful write refreshes them: the lines that had just been written
 * came back with their landed costs as new BASES, the same freight was split
 * again over the new values, and the retry re-sent the written lines at a higher
 * number still (100c -> 200c -> 333c). So Allocate now FREEZES the bill's
 * inputs; a retry sends only the lines that did NOT write, at the allocations
 * they were computed with; and a row that moves underneath an open bill
 * invalidates the whole bill by name instead of quietly re-basing it. Nothing is
 * ever recomputed mid-session.
 *
 * FD2-2 (fix round 3) — THE DRIFT CHECK IS THE SERVER'S. Everything compared
 * above is a render old, and the window between the comparison and the write is
 * exactly where somebody REVERTS a written line to the frozen base: the check
 * passes (it looks like our own line waiting to refresh), the retry skips it as
 * already written, and the bill completes with that line's freight silently
 * missing. So every write carries `ifUnitCostCents` — the value it expects the
 * row to still hold — and the server makes that its WHERE. A retry also
 * RESTATES the lines it already wrote, at the cost it wrote them with: an
 * idempotent no-op whose only job is to make the server prove they are
 * untouched.
 *
 * THE SEAM (S12, extended): the caller rethrows a `PartialAllocationWriteError`.
 * `writtenLineIds` names the lines that landed; `kind: "COST_DRIFT"` says the
 * SERVER refused a precondition. A named field rather than a parsed message —
 * error prose is not a contract. On drift the whole bill is invalidated through
 * the same surface a row-level change uses, because half a bill is not an
 * answer.
 *
 * Accept hands back the per-line unit costs; writing them is the caller's job.
 * A caller whose write FAILS must REJECT (W1S-5), and must name the lines that
 * DID write (`writtenLineIds`), because that is the only way this panel can tell
 * a retry from a re-application.
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

/**
 * The rejection a caller owes this panel when its fan-out write lands only
 * partly. Without `writtenLineIds` the panel assumes NOTHING wrote and offers
 * every line again — safe (the frozen bill re-sends the identical unit cost, so
 * a re-write is idempotent) but noisier than the truth.
 *
 * `kind: "COST_DRIFT"` (FD2-2) is the server's precondition refusal: a line no
 * longer carries the cost this bill was written against. It invalidates the
 * whole bill, so it is a named field rather than something read out of prose.
 */
export interface PartialAllocationWriteError extends Error {
  writtenLineIds?: number[];
  kind?: "COST_DRIFT";
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

/** The ids a failed write reported as written, defensively (it crosses a seam). */
function writtenIdsFrom(error: unknown): number[] {
  const reported = (error as { writtenLineIds?: unknown } | null)?.writtenLineIds;
  if (!Array.isArray(reported)) return [];
  return reported.filter((id): id is number => typeof id === "number");
}

/** Did the SERVER refuse a cost precondition (FD2-2)? Same defensive read. */
function isCostDrift(error: unknown): boolean {
  return (error as { kind?: unknown } | null)?.kind === "COST_DRIFT";
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
  // Lines this session already wrote, with the unit cost they were written at
  // (FD-1). A retry must skip them, and the drift check below must EXPECT the
  // row to come back carrying exactly this number.
  const [written, setWritten] = useState<Record<number, number>>({});
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
   * A fan-out is OUT and its outcome is unknown (FD2-3). While that is true the
   * bill may not be thrown away or re-entered: a late rejection carries
   * `writtenLineIds` for lines that would otherwise land on a cleared session.
   */
  const [accepting, setAccepting] = useState(false);

  const freightCents = parseDollarsToCents(freightInput);
  const freightInvalid = freightInput.trim() !== "" && freightCents === null;
  const writtenIds = Object.keys(written).map(Number);
  /**
   * FD2-3: once ANY line of this bill has been written, the total is settled —
   * part of it is already sitting in real row costs. Editing it would drop the
   * session while `written` survived, leaving a panel with no bill, no Clear,
   * and an Allocate blocked forever by ids nothing could clear. So the input
   * goes read-only and Clear becomes the one transition out.
   */
  const totalLocked = writtenIds.length > 0;

  /** Wipe the bill entirely — the only way back from an invalidated session. */
  const clearBill = () => {
    setFreightInput("");
    setSession(null);
    setEdits({});
    setFlooredConsent({});
    setWritten({});
    setWriteFailed(null);
    setDriftInvalidation(null);
    setApplied(false);
  };

  /**
   * Has the shipment moved underneath the frozen bill?
   *
   * A line this session WROTE may legitimately read back two ways: still at the
   * frozen base (the caller's refetch has not landed yet) or at the cost it was
   * written with (it has). Both are this bill happening, not a stranger's edit —
   * and accepting both is what keeps the retry window from flickering into an
   * invalidation and back. Anything else (a cost changed elsewhere, a recount, a
   * line unlinked) means the split on screen no longer describes this shipment,
   * and the honest answer is to throw the whole bill away rather than re-base
   * half of it.
   */
  const localInvalidation = useMemo<string | null>(() => {
    if (!session) return null;
    const live = new Map(lines.map((line) => [line.id, line]));
    for (const snapshot of session.lines) {
      const now = live.get(snapshot.id);
      if (!now) {
        return `Line "${snapshot.description}" is no longer on this shipment.`;
      }
      const ourOwnWrite = written[snapshot.id];
      if (now.baseCents !== snapshot.baseCents && now.baseCents !== ourOwnWrite) {
        return `The cost of "${snapshot.description}" changed while this bill was open.`;
      }
      if (now.qty !== snapshot.qty) {
        return `The quantity of "${snapshot.description}" changed while this bill was open, and the split rests on it.`;
      }
    }
    return null;
  }, [session, lines, written]);

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
  /** What a press of Accept would send: the writable lines that have NOT written. */
  const pending = writable.filter((s) => written[s.id as number] === undefined);

  const canAllocate =
    !disabled && !busy && !accepting &&
    freightCents !== null && lines.length > 0 && invalidation === null &&
    // A partial write already landed part of this freight in the row costs;
    // re-freezing over them would allocate it a second time. Clear first.
    !totalLocked;

  const canAccept =
    !disabled &&
    !busy &&
    !accepting &&
    active &&
    ok !== null &&
    (validation === null || validation.status === "ok") &&
    pending.length > 0;

  /**
   * What a press of Accept SENDS (FD2-2). Two kinds of line, one shape:
   *
   *   RESTATES  lines this bill already wrote, re-sent at exactly the cost they
   *             were written with and guarded on it. The write is a no-op; the
   *             GUARD is the point — it is the only way to notice that somebody
   *             put the line back to its old cost while the bill was open, which
   *             would otherwise let a retry "complete" with that line's freight
   *             quietly missing. They go FIRST, so a drift is caught before any
   *             further money is written;
   *   PENDING   the lines that have not written, at their frozen allocation,
   *             guarded on the base the split was computed from.
   */
  const buildPayload = (): AllocationWrite[] => {
    if (!session) return [];
    const restates: AllocationWrite[] = session.lines
      .filter((line) => written[line.id] !== undefined)
      .map((line) => ({
        id: line.id,
        unitCostCents: written[line.id],
        ifUnitCostCents: written[line.id],
      }));
    const frozenBase = new Map(session.lines.map((line) => [line.id, line.baseCents]));
    const fresh: AllocationWrite[] = pending.map((s) => ({
      id: s.id as number,
      unitCostCents: s.suggestedUnitCostCents,
      ifUnitCostCents: frozenBase.get(s.id as number) ?? null,
    }));
    return [...restates, ...fresh];
  };

  const handleAllocate = () => {
    if (!canAllocate || freightCents === null) return;
    // THE FREEZE. Everything downstream reads this snapshot, so a refetch can
    // change what the screen COMPARES against but never what it computed.
    setSession({ freightCents, lines });
    setEdits({});
    setFlooredConsent({});
    setWritten({});
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
      // W1S-5: the write did not land, so NOTHING here may look like it did.
      // The bill, the edits and the per-line choices all stay exactly as they
      // were, ready to be retried against whatever actually wrote.
      //
      // FD-1: record WHICH lines wrote, at the cost they were written with. The
      // retry then offers only the rest — never the same freight twice on a line
      // whose base cost has already absorbed it.
      const landed = writtenIdsFrom(error);
      if (landed.length > 0) {
        setWritten((prev) => ({
          ...prev,
          ...Object.fromEntries(
            payload
              .filter((update) => landed.includes(update.id))
              .map((update) => [update.id, update.unitCostCents]),
          ),
        }));
      }
      if (isCostDrift(error)) {
        // FD2-2: the server refused a precondition, so the shipment is not the
        // one this split describes — and no amount of retrying makes it so. The
        // WHOLE bill goes, by name, through the same surface a locally-detected
        // change uses. Deliberately NOT also a "retry the rest" notice: there is
        // nothing left to retry, and saying both would be incoherent.
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
              // FD2-3: a written line makes this total history, not an input.
              // (The field is read-only below; this is the same rule stated
              // where the state actually changes.)
              if (totalLocked) return;
              // A different total is a different bill: the frozen one goes.
              setFreightInput(e.target.value);
              setSession(null);
              setEdits({});
              setFlooredConsent({});
              setApplied(false);
              setWriteFailed(null);
            }}
            placeholder="0.00"
            readOnly={totalLocked}
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
          {`These costs were not written (${writeFailed}). The bill and your edits are kept — Accept again to write only the lines that did not save.`}
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
                  const alreadyWritten = written[line.id];
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
                        {alreadyWritten !== undefined && (
                          <span
                            data-testid="line-written"
                            className="block text-xs text-positive"
                          >
                            {`Already written this bill at ${formatCents(alreadyWritten)} — it will not be sent again.`}
                          </span>
                        )}
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
                          // A written line's share of this bill is already in
                          // the row cost; re-splitting it here would describe a
                          // write that cannot happen again.
                          disabled={disabled || alreadyWritten !== undefined}
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
        {(session !== null || totalLocked) && (
          // FD2-3: offered whenever there is ANY session state to throw away —
          // a bill, or the written lines that outlive one. It needs no token and
          // no permission, and an invalidated bill has no other exit; the ONE
          // moment it is refused is while a fan-out is in flight, because a late
          // rejection would otherwise repopulate a bill somebody just cleared.
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
