"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Link2Off,
  Loader2,
  PackagePlus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCSRF } from "@/hooks/use-csrf";
import {
  shipmentKeys,
  useInboundShipment,
  useUpdateInboundShipment,
  useUpdateStagingLine,
  type ShipmentApiError,
  type ShipmentDetailItem,
} from "@/hooks/use-inbound-shipments";
import {
  useCountStagingItem,
  useLocations,
  useStagingItems,
  type GraduateResponse,
} from "@/hooks/use-staging";
import {
  GraduateDialog,
  type GraduateStagingItem,
} from "@/components/staging/graduate-dialog";
import {
  FreightCalculatorPanel,
  type CalculatorLine,
  type PartialAllocationWriteError,
} from "@/components/receiving/freight-calculator-panel";

/**
 * The receiving DETAIL — the surface this whole lane exists to produce
 * (seam S10; the T4 state matrix rendered).
 *
 * Everything numeric comes from the server: the per-line flags, the rollup, the
 * counts. Nothing here re-derives a discrepancy, and nothing here writes a
 * count through a graduation. The three acts are three requests:
 *
 *   count    POST /api/staging-items/[id]/count   (stamps who + when, audited)
 *   price    PATCH /api/staging-items/[id]        (unitCostCents)
 *   stock    POST /api/staging-items/[id]/graduate via the shared dialog
 *
 * The state matrix is rendered rather than merely enforced: a CLOSED shipment
 * stops offering counts, links and the close button, but KEEPS offering
 * graduation AND per-line pricing (the stranded-line amendment — closing ends
 * receiving, not stocking, and the graduation of a stranded line reads that
 * cost). A CANCELLED shipment offers nothing. The server's 409s remain the real
 * guard; this is just the part that stops an operator walking into one.
 */

/** INT cents -> money. NULL is "not priced", never $0.00 (truthful-data). */
function formatCents(cents: number | null): string {
  if (cents === null) return "Not priced";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Dollars typed by a human -> whole cents; `null` when it is not an amount. */
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * The per-line verdict, in words. "Not counted" is deliberately NOT "0 off":
 * an uncounted line is UNKNOWN, and an unexpected arrival says so out loud
 * because nobody predicted the box that is nonetheless on the dock.
 */
function LineFlag({ item }: { item: ShipmentDetailItem }) {
  const { counted, expectedMissing, delta, direction } = item.flags;

  if (!counted || delta === null) {
    return (
      <span
        data-testid="line-flag"
        className="text-xs font-medium text-muted-foreground"
      >
        Not counted yet
      </span>
    );
  }

  const unexpected = expectedMissing ? "Unexpected arrival — " : "";
  if (direction === "MATCH") {
    return (
      <span data-testid="line-flag" className="text-xs font-medium text-positive">
        {`${unexpected}matches`}
      </span>
    );
  }

  return (
    <span
      data-testid="line-flag"
      className="text-xs font-medium text-amber-700 dark:text-amber-400"
    >
      {`${unexpected}${Math.abs(delta)} ${direction === "OVER" ? "over" : "under"}`}
    </span>
  );
}

interface ShipmentDetailProps {
  shipmentId: string;
}

export function ShipmentDetail({ shipmentId }: ShipmentDetailProps) {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();

  const { data: shipment, isPending, isError, error } = useInboundShipment(shipmentId);
  const { data: locations = [] } = useLocations();
  const updateShipment = useUpdateInboundShipment();
  const updateLine = useUpdateStagingLine();
  const countMutation = useCountStagingItem();

  // Per-line drafts, keyed by staging id. Kept OUT of the row objects so a
  // refetch never clobbers what somebody is halfway through typing.
  const [countDrafts, setCountDrafts] = useState<Record<number, string>>({});
  const [costDrafts, setCostDrafts] = useState<Record<number, string>>({});
  const [busyLineId, setBusyLineId] = useState<number | null>(null);

  // The close guard's 409, kept on screen: it NAMES the lines that blocked it,
  // and a toast that scrolls away would throw that away.
  const [closeBlocked, setCloseBlocked] = useState<number[] | null>(null);

  // W1S-5: where a sequential cost write stopped. The calculator's Accept fans
  // out into one PATCH per line, and those PATCHes are NOT one transaction — so
  // a failure halfway leaves some lines priced and some not, and the operator
  // has to be told which is which before retrying anything.
  const [costWriteReport, setCostWriteReport] = useState<{
    written: number[];
    pending: number[];
  } | null>(null);

  const [graduateItem, setGraduateItem] = useState<GraduateStagingItem | null>(null);
  const [graduateOpen, setGraduateOpen] = useState(false);
  // Products this session created that are NOT live yet. A non-admin's new
  // product is booked with stock but held for approval, and the operator has to
  // hear that from the surface that just created it.
  const [pendingApproval, setPendingApproval] = useState<number[]>([]);

  // Boxes still sitting unlinked in staging — the link picker's whole universe.
  const { data: stagingItems = [] } = useStagingItems("RECEIVED");
  const linkable = useMemo(
    () => stagingItems.filter((item) => (item.shipmentId ?? null) === null),
    [stagingItems],
  );

  const status = shipment?.status;
  const isOpen = status === "OPEN";
  const isCancelled = status === "CANCELLED";
  // Receiving WORK (counting, linking, pricing, closing) stops at the close.
  const receivingActive = isOpen;
  // Stocking outlives it: a line stranded on a closed receipt must still be
  // gradable, or closing a shipment would strand real inventory forever.
  const stockingActive = status === "OPEN" || status === "CLOSED";

  const refreshShipment = () =>
    queryClient.invalidateQueries({ queryKey: shipmentKeys.all });

  const handleCount = async (item: ShipmentDetailItem) => {
    const draft = countDrafts[item.id] ?? "";
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    setBusyLineId(item.id);
    try {
      const result = await countMutation.mutateAsync({
        id: item.id,
        countedQuantity: parsed,
      });
      // The SERVER's number, echoed — never the one that was typed.
      toast.success(`Counted ${result.countedQuantity}`);
      setCountDrafts((prev) => ({ ...prev, [item.id]: "" }));
      await refreshShipment();
    } catch (err) {
      console.error("Error counting receiving line:", err);
      toast.error(err instanceof Error ? err.message : "Failed to record the count");
    } finally {
      setBusyLineId(null);
    }
  };

  const handleCost = async (item: ShipmentDetailItem) => {
    const cents = parseDollarsToCents(costDrafts[item.id] ?? "");
    if (cents === null) return;
    setBusyLineId(item.id);
    try {
      await updateLine.mutateAsync({ id: item.id, body: { unitCostCents: cents } });
      toast.success("Line cost saved");
      setCostDrafts((prev) => ({ ...prev, [item.id]: "" }));
    } catch (err) {
      console.error("Error pricing receiving line:", err);
      toast.error(err instanceof Error ? err.message : "Failed to save the cost");
    } finally {
      setBusyLineId(null);
    }
  };

  const handleUnlink = async (item: ShipmentDetailItem) => {
    setBusyLineId(item.id);
    try {
      await updateLine.mutateAsync({ id: item.id, body: { shipmentId: null } });
      toast.success("Line unlinked — it stays in pre-staging");
    } catch (err) {
      console.error("Error unlinking receiving line:", err);
      toast.error(err instanceof Error ? err.message : "Failed to unlink the line");
    } finally {
      setBusyLineId(null);
    }
  };

  const handleLink = async (stagingItemId: number) => {
    try {
      await updateLine.mutateAsync({ id: stagingItemId, body: { shipmentId } });
      toast.success("Box linked to this shipment");
    } catch (err) {
      console.error("Error linking staging item:", err);
      toast.error(err instanceof Error ? err.message : "Failed to link the box");
    }
  };

  const handleClose = async () => {
    setCloseBlocked(null);
    try {
      await updateShipment.mutateAsync({ id: shipmentId, body: { status: "CLOSED" } });
      toast.success("Shipment closed");
    } catch (err) {
      const apiError = err as ShipmentApiError;
      if (apiError?.uncountedItemIds?.length) {
        setCloseBlocked(apiError.uncountedItemIds);
        return;
      }
      console.error("Error closing shipment:", err);
      toast.error(apiError?.message ?? "Failed to close the shipment");
    }
  };

  const handleCancel = async () => {
    if (
      !window.confirm(
        "Cancel this shipment? Every linked box is unlinked and stays in pre-staging. A shipment with graduated lines cannot be cancelled.",
      )
    ) {
      return;
    }
    try {
      await updateShipment.mutateAsync({ id: shipmentId, body: { status: "CANCELLED" } });
      toast.success("Shipment cancelled");
    } catch (err) {
      const apiError = err as ShipmentApiError;
      console.error("Error cancelling shipment:", err);
      toast.error(apiError?.message ?? "Failed to cancel the shipment");
    }
  };

  const handleGraduated = async (result: GraduateResponse) => {
    if (result.approvalStatus === "PENDING_REVIEW") {
      setPendingApproval((prev) =>
        prev.includes(result.productId) ? prev : [...prev, result.productId],
      );
    }
    await refreshShipment();
  };

  /**
   * The calculator's inputs. Quantity comes from the COUNT when there is one
   * and falls back to what was expected, and the row says which — a freight
   * split resting on a guess has to be visibly resting on a guess.
   */
  const calculatorLines: CalculatorLine[] = useMemo(() => {
    if (!shipment) return [];
    return shipment.items
      .filter((item) => item.status === "RECEIVED")
      .map((item) => {
        const qty = item.countedQuantity ?? item.expectedQuantity ?? 0;
        const qtySource: CalculatorLine["qtySource"] =
          item.countedQuantity !== null
            ? "counted"
            : item.expectedQuantity !== null
              ? "expected"
              : "none";
        return {
          id: item.id,
          description: item.description,
          qty,
          qtySource,
          baseCents: item.unitCostCents,
        };
      });
  }, [shipment]);

  const handleAcceptAllocation = async (
    updates: Array<{ id: number; unitCostCents: number }>,
  ) => {
    const written: number[] = [];
    setCostWriteReport(null);
    try {
      // Sequential on purpose: each PATCH is its own audited change, and a
      // half-applied burst is easier to read in the log than a racing one.
      for (const update of updates) {
        await updateLine.mutateAsync({
          id: update.id,
          body: { unitCostCents: update.unitCostCents },
        });
        written.push(update.id);
      }
      toast.success(`Landed cost written to ${updates.length} line(s)`);
    } catch (err) {
      // W1S-5: RETHROW. These PATCHes are not one transaction, so swallowing the
      // failure told the operator "done" while some lines carried the new landed
      // cost and some still carried the old one — and the panel, believing it had
      // written, cleared the bill they would need to finish the job. Record where
      // it stopped, say so, and let the panel keep everything.
      console.error("Error writing allocated costs:", err);
      setCostWriteReport({
        written,
        pending: updates.map((u) => u.id).filter((id) => !written.includes(id)),
      });
      toast.error(err instanceof Error ? err.message : "Failed to write the costs");
      // FD-1: the rethrow now CARRIES the ids that wrote. Each successful PATCH
      // above invalidated the shipment query, so those lines are about to come
      // back with their landed costs as row costs — and without this list the
      // panel would offer them again and allocate the same freight on top of
      // itself (100c -> 200c -> 333c). Naming them is what makes the retry a
      // retry of the REST.
      const failure: PartialAllocationWriteError =
        err instanceof Error ? err : new Error("Failed to write the costs");
      failure.writtenLineIds = written;
      throw failure;
    }
  };

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading the shipment…
      </div>
    );
  }

  if (isError || !shipment) {
    return (
      <div
        data-testid="shipment-detail-error"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div>
          <p className="font-medium">This shipment could not be loaded.</p>
          <p className="text-muted-foreground">
            {error?.message ?? "It may have been removed."}
          </p>
        </div>
      </div>
    );
  }

  const { discrepancy } = shipment;

  return (
    <div className="space-y-6">
      {/* Header + rollup */}
      <div
        data-testid="shipment-header"
        className="rounded-lg border border-border bg-surface p-4 space-y-3"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 className="truncate text-lg font-semibold">
              {shipment.supplierRef ?? shipment.id}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={isOpen ? "default" : isCancelled ? "outline" : "secondary"}>
                {shipment.status}
              </Badge>
              {shipment.creator && <span>opened by {shipment.creator.username}</span>}
              <span>{new Date(shipment.createdAt).toLocaleDateString()}</span>
            </div>
            {shipment.notes && (
              <p className="text-sm text-muted-foreground">{shipment.notes}</p>
            )}
          </div>

          {receivingActive && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={handleClose}
                disabled={updateShipment.isPending || !csrfToken}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Close shipment
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancel}
                disabled={updateShipment.isPending || !csrfToken}
              >
                <Ban className="mr-2 h-4 w-4" />
                Cancel shipment
              </Button>
            </div>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Lines</dt>
            <dd className="font-medium tabular-nums">{shipment.itemCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Counted</dt>
            <dd className="font-medium tabular-nums">{discrepancy.countedItemCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Over</dt>
            <dd className="font-medium tabular-nums">{discrepancy.totalOver}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Under</dt>
            <dd className="font-medium tabular-nums">{discrepancy.totalUnder}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Over and under are reported separately and never cancel out.
        </p>

        {receivingActive && shipment.uncountedReceivedItemCount > 0 && (
          <p
            data-testid="uncounted-warning"
            className="text-xs font-medium text-amber-700 dark:text-amber-400"
          >
            {`${shipment.uncountedReceivedItemCount} line(s) have not been counted — the shipment cannot be closed until they are.`}
          </p>
        )}

        {closeBlocked && (
          <div
            data-testid="close-blocked"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs"
          >
            <p className="font-medium">
              This shipment still has uncounted received lines and was not closed.
            </p>
            <p className="text-muted-foreground">
              {`Count these lines first: ${closeBlocked.join(", ")}.`}
            </p>
          </div>
        )}

        {costWriteReport && (
          <div
            data-testid="cost-write-partial"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs"
          >
            <p className="font-medium">
              The landed costs were only partly written.
            </p>
            <p className="text-muted-foreground">
              {costWriteReport.written.length > 0
                ? `Written: line(s) ${costWriteReport.written.join(", ")}.`
                : "No line was written."}
              {` Not written: line(s) ${costWriteReport.pending.join(", ")}. The bill is still in the calculator — fix the problem and Accept again, but re-enter costs only for the lines above.`}
            </p>
          </div>
        )}

        {pendingApproval.length > 0 && (
          <div
            data-testid="pending-approval-notice"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
          >
            <p className="font-medium">Awaiting approval</p>
            <p>
              {`The stock is booked, but product(s) ${pendingApproval.join(", ")} are held for admin review and will not appear in the catalog until approved.`}
            </p>
          </div>
        )}
      </div>

      {/* Lines. Cards, not a table: this is read on a phone at the dock. */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Lines</h3>
        {shipment.items.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
            No boxes are linked to this shipment yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {shipment.items.map((item) => {
              const lineBusy = busyLineId === item.id;
              const countable = receivingActive && item.status === "RECEIVED";
              const gradable = stockingActive && item.status === "RECEIVED";
              // W1S-8: pricing follows STOCKING, not receiving. A closed
              // shipment's RECEIVED line can still graduate, and graduation
              // reads this cost — gating the input on `countable` meant the one
              // number the stranded line still needs became unreachable the
              // moment the shipment closed, on the very surface that offers the
              // graduation. The calculator was already gated this way; the
              // per-line input disagreed with it.
              const priceable = gradable;
              const countDraft = countDrafts[item.id] ?? "";
              const countValid = /^\d+$/.test(countDraft.trim());
              const costDraft = costDrafts[item.id] ?? "";
              const costValid = parseDollarsToCents(costDraft) !== null;

              return (
                <li
                  key={item.id}
                  data-testid={`receiving-line-${item.id}`}
                  className="rounded-lg border border-border bg-surface p-3 space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{item.description}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline">{item.status}</Badge>
                        <span>
                          {`Expected ${item.expectedQuantity ?? "—"} · Counted ${item.countedQuantity ?? "—"}`}
                        </span>
                        {item.location && <span>{item.location.name}</span>}
                        <span data-testid="line-cost">{formatCents(item.unitCostCents)}</span>
                      </div>
                      <LineFlag item={item} />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {gradable && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setGraduateItem({
                              id: item.id,
                              description: item.description,
                              expectedQuantity: item.expectedQuantity,
                              countedQuantity: item.countedQuantity,
                              // W1-3b's prop: the receipt line's cost pre-fills
                              // the New-product cost field. One value, typed once.
                              unitCostCents: item.unitCostCents,
                              locationId: item.locationId,
                            });
                            setGraduateOpen(true);
                          }}
                          disabled={lineBusy}
                        >
                          <ArrowUpRight className="mr-1 h-4 w-4" />
                          Graduate
                        </Button>
                      )}
                      {countable && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleUnlink(item)}
                          disabled={lineBusy || !csrfToken}
                        >
                          <Link2Off className="mr-1 h-4 w-4" />
                          Unlink
                        </Button>
                      )}
                    </div>
                  </div>

                  {(countable || priceable) && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {countable && (
                        <div className="space-y-1.5">
                          <Label htmlFor={`count-${item.id}`} className="text-xs">
                            Count
                          </Label>
                          <div className="flex gap-2">
                            <Input
                              id={`count-${item.id}`}
                              type="number"
                              min="0"
                              className="h-9"
                              value={countDraft}
                              onChange={(e) =>
                                setCountDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              placeholder="Units on the dock"
                            />
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleCount(item)}
                              disabled={!countValid || lineBusy || !csrfToken}
                            >
                              Save count
                            </Button>
                          </div>
                        </div>
                      )}

                      {priceable && (
                        <div className="space-y-1.5">
                          <Label htmlFor={`cost-${item.id}`} className="text-xs">
                            Unit cost
                          </Label>
                          <div className="flex gap-2">
                            <Input
                              id={`cost-${item.id}`}
                              inputMode="decimal"
                              className="h-9"
                              value={costDraft}
                              onChange={(e) =>
                                setCostDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              placeholder="0.00"
                            />
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleCost(item)}
                              disabled={!costValid || lineBusy || !csrfToken}
                            >
                              Save cost
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Link an already-logged box. Only while receiving is still open. */}
      {receivingActive && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Link a received box</h3>
          {linkable.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Every received box is already attributed to a shipment. Log new
              boxes in Pre-Staging, then link them here.
            </p>
          ) : (
            <ul className="space-y-2">
              {linkable.slice(0, 20).map((item) => (
                <li
                  key={item.id}
                  data-testid={`linkable-item-${item.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {`Expected ${item.expectedQuantity ?? "—"}${item.vendor ? ` · ${item.vendor}` : ""}`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleLink(item.id)}
                    disabled={updateLine.isPending || !csrfToken}
                  >
                    <PackagePlus className="mr-1 h-4 w-4" />
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* The freight calculator. Pricing a stranded line is still legal on a
          CLOSED shipment, because its graduation reads that cost. */}
      {stockingActive && (
        <FreightCalculatorPanel
          lines={calculatorLines}
          onAccept={handleAcceptAllocation}
          busy={updateLine.isPending}
          disabled={!csrfToken}
        />
      )}

      <GraduateDialog
        open={graduateOpen}
        onOpenChange={setGraduateOpen}
        item={graduateItem}
        locations={locations}
        onSuccess={handleGraduated}
      />
    </div>
  );
}
