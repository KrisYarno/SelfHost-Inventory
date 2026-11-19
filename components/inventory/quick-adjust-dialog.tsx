"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Minus, Package, MapPin, ClipboardCheck } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { useProductLocationQuantity } from "@/hooks/use-product-location-quantity";
import { useProductLocationVersion } from "@/hooks/use-product-location-version";
import {
  invalidateInventoryCaches,
  useAdjustInventory,
  type ApiMutationError,
} from "@/hooks/use-inventory-mutations";
import { useSubmitLatch } from "@/hooks/use-submit-latch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ValueChip } from "@/components/ui/value-chip";
import { ContextTag } from "@/components/ui/context-tag";
import { ReceivingRedirectPrompt } from "@/components/inventory/receiving-redirect-prompt";
import { IntentChip } from "@/components/inventory/intent-chip";
import { OrderNumberField, type OrderCapture } from "@/components/inventory/order-number-field";
import { noLocationSentence } from "@/components/workbench/wc-order-selector";
import type { DeductionIntent } from "@/lib/inventory/intent";
import { apiErrorMessage } from "@/lib/api-error";
import { SELECTED_ORDER_REJECTED_SENTENCE } from "@/lib/orders/order-capture-sentences";
import { ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";
import { cn } from "@/lib/utils";
import type { DialogProduct } from "@/types/inventory";

interface QuickAdjustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: DialogProduct;
  onSuccess?: () => void;
}

// W2-1 (pack REV-11 T7): the Phase-C coded-reason SELECT that used to live here
// is gone. The intent chip replaced it — three values instead of five, mapped
// server-side — and the adjust route now REFUSES the old vocabulary outright,
// so leaving the select in place would have offered operators a field the API
// rejects. One question, one answer, one place it is interpreted.
//
// Reconciliation Part 2, § P2-B3-1R (R-b.2): the dialog, phone first. It opens
// on Remove; a Remove under the `order` chip names its order in ONE field
// (`OrderNumberField`), picked → `selectedExternalOrderId`, typed →
// `orderReference`, never both; one optional Note replaces the required Reason
// (`reason` is never sent). The hosts MOUNT IT PER OPEN (the inventory and
// products pages render it only while their product is set, and null the
// product on close), so every open starts from an empty draft and nothing
// typed for one product can reach another's removal: the FR2/FR3
// product-tagged capture is gone with the shared mount it guarded against.
// Every sentence below is the pack's, byte for byte.
//
// § P2-B3-2 (C2-6): the switch is Remove | Add | Count. Under Count the
// operator types how many are on the shelf, and the save sends that number
// with the row VERSION the dialog read (`useProductLocationVersion`, read once
// per open); the server books the difference, or confirms a match, only while
// that version is still the row's — a stale one is a 409, and the dialog
// clears the count and reads the record again. In count mode every number on
// screen is that read's, and only while no read is in flight. The count lives
// in its OWN state, never the units field's: a number typed as "units to
// remove" is never a count nobody performed. Switching modes hides fields and
// clears nothing. FR1 (row 128): the count field opens only on a KNOWN record
// (never while reading, offline or failed), and a read paused offline is
// shown as offline, never as the record it last held. FR2 (row 130 (1)): after
// a 409 the operator's number never vanishes unexplained — the notice is set
// before the re-read is awaited, outlives a Note edit and a mode toggle, and
// keeps the draft from a stray Escape or tap outside until the count is edited.

/** The largest quantity the field can hold (`maxLength={6}`). */
const MAX_QUANTITY = 999_999;

/** `unit` when the count is 1, `units` otherwise. */
function unitWord(count: number): string {
  return count === 1 ? "unit" : "units";
}

/**
 * The ledger row the 200 carries (`log`), or `null` when the answer has none
 * that can be read — a body that did not parse arrives here as `{}`. Without
 * it nothing can be said about a link either way (FR-R1 (7), CR-OC-5).
 */
function readableLog(result: unknown): { orderRecordId?: unknown } | null {
  const log = (result as { log?: unknown } | null | undefined)?.log;
  return typeof log === "object" && log !== null ? (log as { orderRecordId?: unknown }) : null;
}

/** The stored order id the server stamped the ledger row with (`log.orderRecordId` on the 200). */
function stampedOrderId(result: unknown): string | null {
  const log = readableLog(result);
  return typeof log?.orderRecordId === "string" ? log.orderRecordId : null;
}

/**
 * A picked order the save could not use: the ONE 400 the resolver answers when
 * it can no longer be used (`resolve-selected-order.ts`), or the lock's 409
 * `ORDER_GONE` when it vanished between that check and the write (FR-R1 (3),
 * CR-OC-4). Both get the same recovery.
 */
function isRejectedPick(error: unknown): boolean {
  const err = error as ApiMutationError | null | undefined;
  if (!(err instanceof Error)) return false;
  return (
    (err.code === "VALIDATION_ERROR" && err.message === SELECTED_ORDER_REJECTED_SENTENCE) ||
    err.code === "ORDER_GONE"
  );
}

export function QuickAdjustDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: QuickAdjustDialogProps) {
  const {
    selectedLocationId,
    locations,
    isLoading: locationsLoading,
    loadFailed: locationsLoadFailed,
  } = useLocation();
  // Default Remove (row 106): most adjustments here are stock leaving.
  const [mode, setMode] = useState<"remove" | "add" | "count">("remove");
  // Digits only, as typed: the field refuses anything else.
  const [quantity, setQuantity] = useState("");
  const [quantityRefused, setQuantityRefused] = useState(false);
  // The Count's own field (C2-6): digits only, its own refusal flag, never
  // shared with `quantity`. "" is "nothing entered"; "0" is a count of zero.
  const [counted, setCounted] = useState("");
  const [countRefused, setCountRefused] = useState(false);
  // The 409 notice (stock moved while the operator counted). Cleared ONLY by
  // the count field's own edits (its input and its two steppers): a mode change
  // or a Note edit keeps it (FR2, row 130 (1)).
  const [countNotice, setCountNotice] = useState<string | null>(null);
  // null = the operator has not tapped the chip. Deliberately NOT pre-filled
  // with "other": the request must be able to say "nothing was stated", and a
  // default selection would make every untouched adjustment look answered.
  const [intent, setIntent] = useState<DeductionIntent | null>(null);
  // The capture: HIDDEN, not cleared, when the direction or the chip leaves
  // Remove + `order` (R107-OC-16 / G1-13). The body and the footer read it only
  // under Remove + `order`, so a hidden capture is never sent and never blocks.
  const [capture, setCapture] = useState<OrderCapture>({ text: "", picked: null });
  const [notes, setNotes] = useState("");
  // The rejected pick's notice (non-blocking): which of its two sentences, or
  // none. Cleared by the next edit.
  const [rejectedPick, setRejectedPick] = useState<"number" | "none" | null>(null);
  // The order field takes focus only right after the chip is changed to `order`.
  const focusOrderFieldRef = useRef(false);
  useEffect(() => {
    focusOrderFieldRef.current = false;
  });

  // The units read serves Remove and Add; the version read serves Count. Each is
  // DISABLED outside its modes, not merely unread, so no number in count mode
  // can come from the units read.
  const quantityQuery = useProductLocationQuantity(product.id, selectedLocationId, {
    enabled: open && mode !== "count",
  });
  const versionQuery = useProductLocationVersion(product.id, selectedLocationId, {
    enabled: open && mode === "count",
  });
  const adjustMutation = useAdjustInventory();
  const queryClient = useQueryClient();
  // The shared submit latch (§ P2-B3-1R, M-a.1): one write per tap, and no
  // dismissal while it is in flight. Its ref is set before the request starts
  // and cleared when it settles, failed or not (FD3-1, FD4-1); `busy` is the
  // same fact for rendering (the frozen form, the "…ing" label).
  const { busy, run, guardOpenChange } = useSubmitLatch();

  const isCount = mode === "count";
  const isRemove = mode === "remove";
  const verb = isRemove ? "Remove" : "Add";
  const q = quantity === "" ? null : Number(quantity);
  const unitsPhrase = q === null ? "units" : `${q} ${unitWord(q)}`;
  const location =
    selectedLocationId === null
      ? null
      : (locations.find((loc) => loc.id === selectedLocationId)?.name ?? "Selected location");
  // Stock is KNOWN only on a successful read: loading and failure are their own
  // states, never 0 (row 105, #7). The server's availability check decides.
  const knownStock =
    selectedLocationId !== null && quantityQuery.status === "success" ? quantityQuery.data : null;

  const captureLive = isRemove && intent === "order";
  const sentPick = captureLive ? capture.picked : null;
  const textWellShaped = capture.text !== "" && ORDER_REFERENCE_SHAPE.test(capture.text);
  const sentReference =
    captureLive && capture.picked === null && textWellShaped ? capture.text : null;
  // The pack's one named exception to "never block": text in the live order
  // field that is not an order number keeps arbitrary free text out of
  // `details.orderReference` until it is fixed or cleared (G1-12).
  const captureIllShaped =
    captureLive && capture.picked === null && capture.text !== "" && !textWellShaped;

  // Facelift FR1-1: with no location, the blocker says why — still loading,
  // failed, none configured, or none chosen (F1-18's sentence for that rung).
  const noLocationBlocker =
    selectedLocationId === null
      ? noLocationSentence(
          { isLoading: locationsLoading, loadFailed: locationsLoadFailed, count: locations.length },
          "Close this and choose a location first.",
        )
      : null;

  const blockers: string[] = [];
  if (noLocationBlocker !== null) {
    blockers.push(noLocationBlocker);
  }
  if (q === null || q === 0) blockers.push("Enter how many units.");
  if (isRemove && knownStock !== null && q !== null && q > knownStock) {
    blockers.push(
      `You can't remove more than the ${knownStock} ${unitWord(knownStock)} on record at ${location}.`,
    );
  }
  // REV 118 (QA-10): 21–40 digits are ill-shaped too, so the sentence names the bar.
  if (captureIllShaped) blockers.push("Order number: 1–20 digits only — fix it or clear it.");

  // A standing 409 notice is draft too: the 409 empties the count field, and
  // the notice is then the operator's only record of the number (row 130 (1)).
  const draftNonEmpty =
    quantity !== "" ||
    counted !== "" ||
    countNotice !== null ||
    capture.text !== "" ||
    capture.picked !== null ||
    notes !== "" ||
    intent !== null;

  const summary = `${verb} ${unitsPhrase} of ${product.name}${location !== null ? ` at ${location}` : ""}`;
  const actionLabel = busy ? `${isRemove ? "Removing" : "Adding"} ${unitsPhrase}…` : `${verb} ${unitsPhrase}`;
  const orderLine = !captureLive
    ? null
    : capture.picked !== null
      ? `Order ${capture.picked.orderNumber} · ${capture.picked.store}`
      : textWellShaped
        ? `Order number to save: ${capture.text}`
        : capture.text === ""
          ? "No order number — this removal won't be linked to an order."
          : null;
  const rejectedNotice =
    rejectedPick === null
      ? null
      : rejectedPick === "number"
        ? `That order can't be used anymore — tap "${verb} ${unitsPhrase}" again to save the number; it links only if one order with that number is found.`
        : `That order can't be used anymore — tap "${verb} ${unitsPhrase}" again to save without an order number.`;
  const message = blockers[0] ?? rejectedNotice;

  const preview =
    knownStock !== null && location !== null && q !== null && q >= 1
      ? knownStock + (isRemove ? -q : q)
      : null;

  // --- Count mode (C2-6) ----------------------------------------------------
  const n = counted === "" ? null : Number(counted);
  // The record, as the version read says it. In flight is `fetchStatus ===
  // "fetching"` — the first read AND a refetch, whose old answer stays in
  // `data` and is NOT shown. A read the device is too offline to start or
  // finish is `fetchStatus === "paused"` (FR1, row 128 (1)): its old answer is
  // not shown either — after a 409 it is the record the server just refuted —
  // and the read resumes by itself on reconnect (a paused fetch continues
  // whatever `refetchOnReconnect` says). A failed refetch keeps its old `data`
  // too, so "known" needs `status === "success"`, never `data` alone.
  const countRead: "no-location" | "reading" | "offline" | "failed" | "known" =
    selectedLocationId === null
      ? "no-location"
      : versionQuery.fetchStatus === "fetching"
        ? "reading"
        : versionQuery.fetchStatus === "paused"
          ? "offline"
          : versionQuery.status === "error" || versionQuery.data === null
            ? "failed"
            : versionQuery.status === "success"
              ? "known"
              : "reading";
  const record = countRead === "known" ? (versionQuery.data ?? null) : null;
  // FR1, row 128 (2): the field and its steppers take a count only once the
  // record is KNOWN, so no count is ever typed before the version it will be
  // checked against is on screen.
  const countFieldDisabled = countRead !== "known";
  // In EVERY count string: never "at null" (B3-2-G1-5 / OC1-7).
  const at = location !== null ? ` at ${location}` : "";

  const countSummary =
    n === null
      ? `Count ${product.name}${at}`
      : record === null
        ? `Count ${n} ${unitWord(n)} of ${product.name}${at}`
        : n !== record.quantity
          ? `Set ${product.name}${at} to ${n} ${unitWord(n)} (record: ${record.quantity})`
          : `Confirm ${n} ${unitWord(n)} of ${product.name}${at}`;
  const countActionLabel = busy
    ? "Saving count…"
    : n === null || record === null
      ? "Save count"
      : n !== record.quantity
        ? `Set to ${n}`
        : `Confirm ${n}`;
  const countPreview =
    n === null || record === null
      ? null
      : n !== record.quantity
        ? `The record says ${record.quantity} ${unitWord(record.quantity)} — saving sets it to ${n} (${n - record.quantity > 0 ? "+" : ""}${n - record.quantity}).`
        : `Matches the record — saving confirms ${n} ${unitWord(n)}.`;
  // The FIRST that applies. The 409 notice ranks ABOVE "nothing entered",
  // because the 409 empties the field (B3-2-G1-1 / OC1-1), and BELOW the read
  // states, so a notice set while the re-read failed shows once it recovers.
  // Offline is a wait, not an error: MUTED, like the read in flight.
  const countMessage: { text: string; tone: "destructive" | "muted" | "warning" } | null =
    noLocationBlocker !== null
      ? { text: noLocationBlocker, tone: "destructive" }
      : countRead === "reading"
        ? { text: "Reading stock…", tone: "muted" }
        : countRead === "offline"
          ? { text: "You're offline — stock will be read when you reconnect.", tone: "muted" }
          : countRead === "failed"
            ? { text: "Couldn't read current stock — tap Try again.", tone: "destructive" }
            : countNotice !== null
              ? { text: countNotice, tone: "warning" }
              : n === null
                ? { text: "Enter the number you counted.", tone: "destructive" }
                : null;
  // Save is dead by the CONDITIONS, whichever message is showing.
  const countBlocked = selectedLocationId === null || record === null || n === null;

  const footerMessage = isCount ? (countMessage?.text ?? null) : message;
  const footerTone = isCount
    ? (countMessage?.tone ?? "warning")
    : blockers.length > 0
      ? "destructive"
      : "warning";

  // Cancel and the X discard (the host unmounts the dialog); while a save is in
  // flight the guard drops them, as it drops Escape and a click outside. It
  // reads the latch's synchronous ref (FD3-1). The request's own answer still
  // closes the dialog — `handleSubmit` calls the host's RAW `onOpenChange`,
  // never this guard, which would drop it — and a failed one leaves it open.
  const handleOpenChange = guardOpenChange(onOpenChange);

  /**
   * Any edit clears the rejected pick's notice. The count's notice is NOT
   * cleared here: only the count field's own edits clear it (row 130 (1)).
   */
  const edited = () => {
    setRejectedPick(null);
  };

  const handleModeChange = (next: "remove" | "add" | "count") => {
    setMode(next);
    edited();
  };

  const handleQuantityInput = (raw: string) => {
    if (!/^[0-9]*$/.test(raw)) {
      // REFUSED: the value stays as it was, and the field says why.
      setQuantityRefused(true);
      return;
    }
    const next = raw.replace(/^0+(?=[0-9])/, "");
    setQuantity(next);
    if (next === "") setQuantityRefused(false);
    edited();
  };

  const handleIncrement = () => {
    setQuantity((prev) => String(Math.min((prev === "" ? 0 : Number(prev)) + 1, MAX_QUANTITY)));
    edited();
  };

  const handleDecrement = () => {
    if (q === null || q <= 1) return;
    setQuantity(String(q - 1));
    edited();
  };

  // The count field: the units field's refusal rule, but 0 is a count.
  const handleCountInput = (raw: string) => {
    if (!/^[0-9]*$/.test(raw)) {
      setCountRefused(true);
      return;
    }
    const next = raw.replace(/^0+(?=[0-9])/, "");
    setCounted(next);
    if (next === "") setCountRefused(false);
    setCountNotice(null);
    edited();
  };

  // `+` from empty gives 1 — never the record + 1.
  const handleCountIncrement = () => {
    setCounted((prev) => String(Math.min((prev === "" ? 0 : Number(prev)) + 1, MAX_QUANTITY)));
    setCountNotice(null);
    edited();
  };

  const handleCountDecrement = () => {
    if (n === null || n <= 0) return;
    setCounted(String(n - 1));
    setCountNotice(null);
    edited();
  };

  const handleIntentChange = (next: DeductionIntent) => {
    if (next === "order" && intent !== "order") focusOrderFieldRef.current = true;
    setIntent(next);
    edited();
  };

  const handleCaptureChange = (next: OrderCapture) => {
    setCapture(next);
    edited();
  };

  const handleNotesChange = (next: string) => {
    setNotes(next);
    edited();
  };

  const handleSubmit = async () => {
    if (blockers.length > 0 || selectedLocationId === null || q === null) return;
    const delta = isRemove ? -q : q;
    const sentNotes = notes.trim();

    try {
      // One removal per tap: a second tap before the label changes would
      // otherwise send a second request (B3-1 FD3-1). `run` answers it
      // `undefined` while this one holds the latch, and releases the latch when
      // the request settles, failed or not (FD4-1), before the lines below run.
      const settled = await run(async () => ({
        result: await adjustMutation.mutateAsync({
          productId: product.id,
          locationId: selectedLocationId,
          delta,
          // The Note; `reason` is never sent.
          ...(sentNotes !== "" ? { notes: sentNotes } : {}),
          // The intent only on Remove, and absent (not null) when the chip was
          // never tapped — the route reads key PRESENCE to tell "unstated"
          // from "stated as other".
          ...(isRemove && intent !== null ? { intent } : {}),
          // The identity only on Remove + `order`: the picked id XOR the typed
          // number. Absent keys, never empty values.
          ...(sentPick !== null
            ? { selectedExternalOrderId: sentPick.id }
            : sentReference !== null
              ? { orderReference: sentReference }
              : {}),
        }),
      }));
      if (settled === undefined) return;
      const { result } = settled;

      const units = `${q} ${unitWord(q)}`;
      if (!isRemove) {
        toast.success(`Added ${units} of ${product.name} at ${location}.`);
      } else if (readableLog(result) === null) {
        // A 200 whose ledger row can't be read: the removal happened, and
        // nothing is known about a link — so nothing is claimed (FR-R1 (7)).
        toast.success(`Removed ${units} of ${product.name} at ${location}.`);
      } else if (intent !== "order") {
        toast.success(`Removed ${units} of ${product.name} at ${location}.`);
      } else if (sentPick === null && sentReference === null) {
        toast.success(`Removed ${units} of ${product.name} at ${location} — not linked to an order.`);
      } else if (stampedOrderId(result) !== null) {
        toast.success(
          `Removed ${units} of ${product.name} — linked to order ${sentPick?.orderNumber ?? sentReference}.`,
        );
      } else if (sentReference !== null) {
        // ONE sentence for every way a typed number did not land — unmatched,
        // ambiguous, not yours, unusable, or the lookup failing. The removal
        // itself succeeded, and the number is on its audit event. Held for 10 s
        // (the house idiom for a toast that must be read).
        toast(
          `Removed ${units} of ${product.name}. Order ${sentReference} wasn't linked — the number is saved so an admin can link it later.`,
          { duration: 10000 },
        );
      } else {
        // A pick the server did not stamp: never said as linked, and its number
        // is not on the event (only a typed number is), so nothing is promised.
        toast.success(`Removed ${units} of ${product.name} at ${location} — not linked to an order.`);
      }

      // The host's RAW callback, never the guard (`handleOpenChange`), which
      // drops a close while a submit holds the latch.
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      if (sentPick !== null && isRejectedPick(error)) {
        // The picked order can't be used anymore (deleted, or no longer the
        // operator's). No error toast: keep the number when it is one, drop the
        // pick, and let the next tap save the number — which the server then
        // resolves like any typed number (it links only on one match).
        //
        // FR-R2 (2), QA-2: every cached order search is marked stale BEFORE the
        // number comes back, so the field asks the search again instead of
        // re-offering the dead order from its cache (a pick → reject → pick loop).
        void queryClient.resetQueries({ queryKey: ["admin", "reconciliation", "orders"] });
        const text = ORDER_REFERENCE_SHAPE.test(sentPick.orderNumber) ? sentPick.orderNumber : "";
        setCapture({ text, picked: null });
        setRejectedPick(text === "" ? "none" : "number");
        return;
      }
      console.error("Error adjusting inventory:", error);
      // FR-R2 (7), QA-8: the house reader over the failed body — a code whose
      // server sentence is not for the operator (`ORDER_GONE` names an internal
      // id) gets the client's own copy; anything else keeps its sentence.
      const body = error instanceof Error ? (error as ApiMutationError).data : undefined;
      toast.error(
        apiErrorMessage(body, error instanceof Error ? error.message : "Failed to adjust inventory"),
      );
    }
  };

  const handleCountSubmit = async () => {
    if (countBlocked || selectedLocationId === null || n === null || record === null) return;
    const sentNotes = notes.trim();

    try {
      // One count per tap, through the same latch as the delta path.
      const settled = await run(async () => ({
        result: await adjustMutation.mutateAsync({
          productId: product.id,
          locationId: selectedLocationId,
          intent: "count",
          countedQuantity: n,
          // The version on screen, read before the count was typed (C2-5).
          expectedVersion: record.version,
          ...(sentNotes !== "" ? { notes: sentNotes } : {}),
        }),
      }));
      if (settled === undefined) return;
      const answer = (settled.result ?? {}) as { changed?: unknown; previousQuantity?: unknown };

      if (answer.changed === true && typeof answer.previousQuantity === "number") {
        toast.success(
          `Counted ${n} of ${product.name} at ${location} — stock went from ${answer.previousQuantity} to ${n}.`,
        );
      } else if (answer.changed === false) {
        toast.success(`Count confirmed — ${n} of ${product.name} at ${location} matches the record.`);
      } else {
        // An answer that can't be read (an unparseable body arrives as `{}`):
        // the count was saved, and nothing is claimed about what changed.
        toast.success(`Saved the count of ${n} for ${product.name} at ${location}.`);
      }

      // The host's RAW callback, never the guard, as on the delta path.
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      if (error instanceof Error && (error as ApiMutationError).code === "OPTIMISTIC_LOCK_ERROR") {
        // Stock moved while the operator counted. No error toast and the dialog
        // stays: the count taken against the old record is CLEARED, so a second
        // tap cannot resubmit it; the list behind and the units read refresh;
        // and the record is read again, the notice built from THAT answer (the
        // returned result, never this closure's `record`).
        setCounted("");
        setCountRefused(false);
        // FR2, row 130 (1): the notice is set BEFORE the re-read is awaited — a
        // re-read paused offline does not return until the connection does, and
        // the operator's number must stand (and keep the draft) meanwhile. It
        // ranks below the read states, so it shows once the read is known; a
        // re-read that FAILS leaves it as it is (FR1, row 128 (4)).
        setCountNotice(`Stock changed while you were counting — you entered ${n}. Count again, then save.`);
        void invalidateInventoryCaches(queryClient, product.id);
        const next = await versionQuery.refetch();
        if (next.status === "success" && next.data !== null) {
          setCountNotice(
            next.data.quantity === n
              ? // FR1, row 128 (3): the record already IS the count — most
                // likely this count's own earlier tap committed and its reply
                // was lost, so this 409 is the token refusing a second write.
                `The record already says ${n} — your count may already have been saved. Check the product's history, or count again.`
              : `Stock changed while you were counting — you entered ${n}; the record now says ${next.data.quantity}. Count again, then save.`,
          );
        }
        return;
      }
      console.error("Error adjusting inventory:", error);
      const body = error instanceof Error ? (error as ApiMutationError).data : undefined;
      toast.error(
        apiErrorMessage(body, error instanceof Error ? error.message : "Failed to adjust inventory"),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[500px] max-h-[85dvh]"
        aria-describedby={undefined}
        // A non-empty draft is not thrown away by a stray Escape or a tap
        // outside; Cancel and the X still discard it.
        onEscapeKeyDown={(event) => {
          if (draftNonEmpty) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (draftNonEmpty) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
        </DialogHeader>

        {/* Product Info */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Package className="h-4 w-4" />
            <span>Product</span>
          </div>
          <h4 className="mt-1 text-base font-semibold">{product.name}</h4>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="adjust-stock">
            {location !== null && (
              <ContextTag icon={<MapPin className="h-3 w-3 text-muted-foreground" />}>
                {location}
              </ContextTag>
            )}
            {selectedLocationId === null ? (
              <span className="text-muted-foreground">No location selected.</span>
            ) : isCount ? (
              // Count: the version read's number, only when nothing is fetching.
              countRead === "offline" ? (
                <span className="text-muted-foreground">
                  You&apos;re offline — stock will be read when you reconnect.
                </span>
              ) : countRead === "failed" ? (
                <>
                  <span className="text-destructive">Couldn&apos;t read current stock.</span>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="count-retry"
                    className="min-h-[44px]"
                    onClick={() => void versionQuery.refetch()}
                  >
                    Try again
                  </Button>
                </>
              ) : record !== null ? (
                <ValueChip tone={record.quantity > 0 ? "positive" : record.quantity < 0 ? "negative" : "neutral"}>
                  {`${record.quantity} ${unitWord(record.quantity)}`}
                </ValueChip>
              ) : (
                <span className="text-muted-foreground">Reading stock…</span>
              )
            ) : quantityQuery.status === "error" ? (
              <span className="text-destructive">
                Couldn&apos;t read current stock — it will be checked when you save.
              </span>
            ) : knownStock !== null ? (
              <ValueChip tone={knownStock > 0 ? "positive" : knownStock < 0 ? "negative" : "neutral"}>
                {`${knownStock} ${unitWord(knownStock)}`}
              </ValueChip>
            ) : (
              <span className="text-muted-foreground">Reading stock…</span>
            )}
          </div>
        </div>

        {/* While saving, the WHOLE form is frozen (row 105, #13). */}
        <fieldset disabled={busy} className="min-w-0">
          <div className="space-y-4">
            <div className="space-y-4">
              {/* The switch: a segmented Remove | Add | Count, Remove first.
                  The 360 px budget (B3-2-G1-6 / OC1-3): each track is about
                  91 px, so the buttons pad tighter than the Button default and
                  the icons show only from 400 px. */}
              <div
                role="group"
                aria-label="Remove, add or count"
                className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/30 p-1"
              >
                {(["remove", "add", "count"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={mode === value ? "default" : "ghost"}
                    aria-pressed={mode === value}
                    className="min-h-[44px] px-2 gap-1.5"
                    onClick={() => handleModeChange(value)}
                  >
                    {value === "remove" ? (
                      <Minus className="hidden min-[400px]:block" />
                    ) : value === "add" ? (
                      <Plus className="hidden min-[400px]:block" />
                    ) : (
                      <ClipboardCheck className="hidden min-[400px]:block" />
                    )}
                    {value === "remove" ? "Remove" : value === "add" ? "Add" : "Count"}
                  </Button>
                ))}
              </div>

              {/* Count: how many are on the shelf. EMPTY on entry and NO
                  placeholder — the record is the stock line above, never a grey
                  number inside the field that reads as a count already taken. */}
              {isCount && (
                <div className="space-y-2">
                  <Label htmlFor="count" className="text-xs font-medium text-muted-foreground">
                    {location !== null ? `How many are on the shelf at ${location}?` : "How many are on the shelf?"}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-11 w-11 shrink-0 rounded-md border-border"
                      aria-label="Decrease count"
                      onClick={handleCountDecrement}
                      disabled={countFieldDisabled || n === null || n <= 0}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Input
                      id="count"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={counted}
                      onChange={(e) => handleCountInput(e.target.value)}
                      onBlur={() => setCountRefused(false)}
                      disabled={countFieldDisabled}
                      className="h-11 flex-1 text-center text-lg font-semibold tabular-nums"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-11 w-11 shrink-0 rounded-md border-border"
                      aria-label="Increase count"
                      onClick={handleCountIncrement}
                      disabled={countFieldDisabled}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {countRefused && (
                    <p role="status" data-testid="count-refused" className="text-[11px] text-destructive">
                      Whole units only.
                    </p>
                  )}
                  {countPreview !== null && (
                    <p data-testid="count-preview" className="text-[11px] text-muted-foreground">
                      {countPreview}
                    </p>
                  )}
                </div>
              )}

              {/* Quantity — Remove and Add only. */}
              {!isCount && (
                <div className="space-y-2">
                  <Label htmlFor="quantity" className="text-xs font-medium text-muted-foreground">
                    {isRemove ? "Units to remove" : "Units to add"}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-11 w-11 shrink-0 rounded-md border-border"
                      aria-label="Decrease quantity"
                      onClick={handleDecrement}
                      disabled={q === null || q <= 1}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Input
                      id="quantity"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={quantity}
                      onChange={(e) => handleQuantityInput(e.target.value)}
                      onBlur={() => setQuantityRefused(false)}
                      className="h-11 flex-1 text-center text-lg font-semibold tabular-nums"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-11 w-11 shrink-0 rounded-md border-border"
                      aria-label="Increase quantity"
                      onClick={handleIncrement}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {quantityRefused && (
                    <p role="status" data-testid="quantity-refused" className="text-[11px] text-destructive">
                      Whole units only.
                    </p>
                  )}
                  {preview !== null && (
                    <p data-testid="quantity-preview" className="text-[11px] text-muted-foreground">
                      After this, {location} will have{" "}
                      <span
                        className={cn(
                          "font-semibold",
                          preview < 0 ? "text-destructive" : "text-positive",
                        )}
                      >
                        {`${preview} ${unitWord(preview)}`}
                      </span>
                      .
                    </p>
                  )}
                </div>
              )}

              {/* W2-1 (T7): the intent chip — on Remove only. Skippable; it never
                  blocks the save. */}
              {isRemove && (
                <IntentChip
                  surface="adjust"
                  layout="row"
                  value={intent}
                  onChange={handleIntentChange}
                  disabled={busy}
                />
              )}

              {/* The capture: ONLY on a Remove under `order`. */}
              {captureLive && (
                <OrderNumberField
                  productId={product.id}
                  quantity={q}
                  value={capture}
                  onChange={handleCaptureChange}
                  disabled={busy}
                  focusOnMount={focusOrderFieldRef.current}
                />
              )}

              {/* T5 (pack REV-3): a POSITIVE delta here is stock arriving with no
                  receipt behind it. The prompt offers /receiving once per session
                  and never blocks — declining submits the identical adjustment. */}
              {mode === "add" && <ReceivingRedirectPrompt active={q !== null && q > 0} />}

              {/* The Note: optional, shown in the product's history to admins and its author. */}
              <div className="space-y-2">
                <Label htmlFor="note">Note (optional)</Label>
                <Textarea
                  id="note"
                  value={notes}
                  onChange={(e) => handleNotesChange(e.target.value)}
                  placeholder="Anything someone reviewing this should know"
                  maxLength={2000}
                  rows={3}
                  aria-describedby="note-helper"
                />
                <p id="note-helper" className="text-[11px] text-muted-foreground">
                  Seen by admins and by you.
                </p>
              </div>
            </div>

            {/* The sticky footer: what the tap will do, and the tap. */}
            <div
              data-testid="adjust-footer"
              className="sticky bottom-0 -mx-4 px-4 sm:-mx-6 sm:px-6 -mb-4 pb-4 sm:-mb-6 sm:pb-6 bg-background border-t pt-3"
            >
              <p data-testid="adjust-summary" className="break-words text-sm font-medium">
                {isCount ? countSummary : summary}
              </p>
              {orderLine !== null && (
                <p data-testid="adjust-order-line" className="break-words text-[11px] text-muted-foreground">
                  {orderLine}
                </p>
              )}
              {footerMessage !== null && (
                <p
                  data-testid="adjust-message"
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "mt-1 break-words text-[11px]",
                    footerTone === "destructive"
                      ? "text-destructive"
                      : footerTone === "muted"
                        ? "text-muted-foreground"
                        : "text-warning",
                  )}
                >
                  {footerMessage}
                </p>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => handleOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="min-h-[44px]"
                  onClick={isCount ? handleCountSubmit : handleSubmit}
                  disabled={(isCount ? countBlocked : blockers.length > 0) || busy}
                >
                  {isCount ? countActionLabel : actionLabel}
                </Button>
              </div>
            </div>
          </div>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
