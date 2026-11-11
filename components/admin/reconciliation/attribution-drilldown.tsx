"use client";

/**
 * components/admin/reconciliation/attribution-drilldown.tsx — everything the
 * server knows about one batch (pack C4a.2; spec REV-7 §4.2).
 *
 * Four sources, kept APART on purpose, because merging them is exactly how this
 * page would start inventing history:
 *
 *   - THE LEDGER ROWS: what actually moved, and which order id each row carries.
 *   - THE AUDIT EVENT: the operator's own free text, under the producer's own
 *     label — it is admin-visible input, not a fact the system derived.
 *   - THE ATTEMPTS: what was RECORDED live, newest first.
 *   - THE ATTRIBUTION EVENTS: manual corrections, with their reasons.
 *
 * And when no attempt was ever recorded, the DERIVED sentence — labelled as
 * derived, with its rule id, so nobody reads a read-time computation as
 * something the pipeline said at the time.
 *
 * EVERY LIST HERE IS A PAGE, and every one of them says so when it is (OC-8 for
 * the ledger, CR-4 for the two append-only histories). The producer decides the
 * bound and hands over the total; this file only renders the sentence. A short
 * list silently read as a complete record is the untruth these lines exist for.
 *
 * AND A FIFTH SOURCE (Part 2, pack CA3): THE ORDER'S MATCH — what the order
 * asked for beside what left stock against it. It is kept apart from the four
 * above for the same reason they are kept apart from each other: attribution is
 * BATCH grain and the match is ORDER grain, so this panel describes the order
 * the batch's rows name, not the batch. Everything it cannot compare — unmapped
 * lines, bundle lines that would not expand, products the mass balance refused —
 * is said in the panel, because each of them is a piece of the order the class
 * had no opinion about.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBatchDetail, useMoveBatch } from "@/hooks/use-admin";
import { ReverseConfirm } from "@/components/admin/reconciliation/reverse-confirm";
import {
  MoveBatchDialog,
  type MoveTarget,
} from "@/components/workbench/move-batch-dialog";
import {
  FLAGGED_MATCH_CLASSES,
  MATCH_DEFINITIONS,
  MATCH_UNAVAILABLE_COPY,
  type MatchKind,
  type MatchUnavailableReason,
} from "@/lib/reconciliation/match-keys";
import type { PerProduct, ToleranceReport } from "@/lib/reconciliation/match";
import type { AttributionRow, BatchDetail, WireOrderMatch } from "@/lib/reconciliation/attribution";
import {
  FULFILLMENT_TARGET_MISSING_COPY,
  MATCH_NOT_COMPUTED_COPY,
  fulfilledAgainstCopy,
  matchClassLabel,
  matchDefinition,
  matchToneClass,
} from "./attribution-row";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** The shell's own `?tab=` shape — the finder is a tab, not a route of its own. */
const UNMAPPED_TAB_HREF = "/admin/reconciliation?tab=unmapped";
const EXCEPTIONS_TAB_HREF = "/admin/reconciliation?tab=exceptions";

/**
 * VERBATIM (spec §4.1). A bundle's components are deducted through the ORDER
 * intent or the fulfil path, so an admin looking at a component line here needs
 * to be told where the correction is actually made.
 */
export const FROM_BUNDLE_COPY =
  "from bundle — deduct via the adjust page's Order intent or fulfil";

/** The per-product difference in words. ONE map, so the wording has one owner. */
const KIND_COPY: Readonly<Record<MatchKind, string>> = {
  missing: "missing",
  short: "short by",
  over: "over by",
  extra: "extra",
  // Not a shortfall and not a surplus: corrections gave back more than ever
  // left. It is history, and the words say what happened rather than "over".
  overrun: "corrections exceed outbound by",
};

/** Why a product carrying a difference never entered the mass balance. */
const EXCLUDED_REASON_COPY: Readonly<
  Record<ToleranceReport["excludedProducts"][number]["reason"], string>
> = {
  undecomposable: "cannot be decomposed",
  "unit-refused": "unit not comparable",
};

/**
 * The adjust page's audit event (B3-1 FR3, Q/A B3-1-QA-2). Its writer NEVER
 * records a picked id on the event (B3-1 FR1, F2: it records
 * `orderAttributionSource` instead), so "none" there would say the operator
 * picked nothing when the attempt below reads `attributed / selected`.
 */
const ADJUSTMENT_ACTION_TYPE = "INVENTORY_ADJUSTMENT";

function orderPickedText(auditEvent: NonNullable<BatchDetail["auditEvent"]>): string {
  if (auditEvent.selectedExternalOrderId !== undefined) return auditEvent.selectedExternalOrderId;
  if (auditEvent.actionType === ADJUSTMENT_ACTION_TYPE) return "not recorded on this event";
  return "none";
}

/** HOW the writer stamped the ledger, in words; an unknown value shows as stored. */
function stampedFromText(source: string): string {
  if (source === "selected") return "a picked order";
  if (source === "reference-resolved") return "a typed order number";
  return source;
}

/** Integer hundredths in the unit's own scale: 1000 -> "10", 29 -> "0.29". */
function massText(hundredths: number): string {
  return String(Number((hundredths / 100).toFixed(2)));
}

/**
 * The difference in words — and only where the matcher actually compared (QA-2).
 * A class-less match listed its deducted products without comparing them, and
 * a tolerance-nulled row differs by mass the swap explains below; "no
 * difference" is true of neither.
 */
function kindText(match: WireOrderMatch, product: PerProduct): string {
  if (match.class === null) return "not compared";
  if (product.kind === null) return product.delta === 0 ? "no difference" : "balanced (see swap below)";
  return `${KIND_COPY[product.kind]} ${product.units}`;
}

/**
 * The product's name, from `perProduct` — the ONLY string inside the match that
 * names anything (pack rule 5). A group member the per-product list does not
 * hold cannot happen (both come from the same rows); it reads as its id rather
 * than as a blank if it ever does.
 */
function productNameOf(match: WireOrderMatch, productId: number): string {
  const product = match.perProduct.find((row) => row.productId === productId);
  return product === undefined ? `product ${productId}` : product.productName;
}

function memberText(
  match: WireOrderMatch,
  member: { productId: number; units: number; hundredths: number },
  unit: string,
): string {
  return `${productNameOf(match, member.productId)} x${member.units} @ ${massText(member.hundredths)} ${unit}`;
}

/** One BALANCED group, with the mass it balanced at — the audit of a tolerance. */
function groupText(
  match: WireOrderMatch,
  group: ToleranceReport["equivalentGroups"][number],
): string {
  const shortfall = group.shortfall.map((m) => memberText(match, m, group.unit)).join(", ");
  const extra = group.extra.map((m) => memberText(match, m, group.unit)).join(", ");
  return `Swap within ${group.familyKey} (${group.unit}): ${shortfall} ⇄ ${extra} — balanced at ${massText(group.massHundredths)} ${group.unit}`;
}

/**
 * THE "THIS ORDER" PANEL. Every product on EITHER side is listed, including the
 * ones with no difference: a table of only the differences would read as the
 * order's lines, and an admin would count what is missing from a list that never
 * claimed to be complete.
 */
function OrderMatchPanel({ match }: { match: WireOrderMatch }) {
  const flagged = match.class !== null && FLAGGED_MATCH_CLASSES.has(match.class);

  return (
    <div className="space-y-3" data-testid="order-match-panel">
      <div>
        <p className={matchToneClass(match)}>{matchClassLabel(match)}</p>
        {/* The definition rides with the class (truthful-data): a class name on
            its own is a word, not a claim anybody can check. */}
        <p className="text-body-sm text-muted-foreground">{matchDefinition(match)}</p>
      </div>

      <div className="hidden md:block" data-testid="order-match-products">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Ordered</TableHead>
              <TableHead>Deducted</TableHead>
              <TableHead>Corrected</TableHead>
              <TableHead>Difference</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {match.perProduct.map((product) => (
              <TableRow
                key={product.productId}
                data-testid={`order-match-product-${product.productId}`}
              >
                <TableCell>
                  {product.productName}
                  {product.fromBundle && (
                    <span
                      className="ml-2 text-body-sm text-muted-foreground"
                      title={FROM_BUNDLE_COPY}
                      data-testid={`order-match-from-bundle-${product.productId}`}
                    >
                      from bundle
                    </span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{product.ordered}</TableCell>
                <TableCell className="tabular-nums">{product.deducted}</TableCell>
                <TableCell className="tabular-nums">{product.corrected}</TableCell>
                <TableCell>{kindText(match, product)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* MOBILE stacks (spec §7): the same five facts, one card per product. */}
      <div className="space-y-2 md:hidden" data-testid="order-match-product-cards">
        {match.perProduct.map((product) => (
          <div
            key={product.productId}
            data-testid={`order-match-product-card-${product.productId}`}
            className="rounded-lg border border-border bg-surface p-3 text-body-sm"
          >
            <p className="font-medium">
              {product.productName}
              {product.fromBundle && (
                <span className="ml-2 font-normal text-muted-foreground" title={FROM_BUNDLE_COPY}>
                  from bundle
                </span>
              )}
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1">
              <div className="min-w-0">
                <dt className="text-muted-foreground">Ordered</dt>
                <dd className="tabular-nums">{product.ordered}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">Deducted</dt>
                <dd className="tabular-nums">{product.deducted}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">Corrected</dt>
                <dd className="tabular-nums">{product.corrected}</dd>
              </div>
            </dl>
            <p className="mt-2">{kindText(match, product)}</p>
          </div>
        ))}
      </div>

      {match.bundleLines > 0 && (
        <p className="text-body-sm text-muted-foreground" data-testid="order-match-bundle-lines">
          {match.bundleLines} bundle line(s) expanded into the products above — {FROM_BUNDLE_COPY}
        </p>
      )}

      {match.tolerance !== null && (
        <div className="space-y-1 text-body-sm" data-testid="order-match-tolerance">
          {match.tolerance.equivalentGroups.map((group) => (
            <p key={`${group.familyKey} ${group.unit}`}>{groupText(match, group)}</p>
          ))}
          {match.tolerance.excludedProducts.length > 0 && (
            <ul className="text-muted-foreground" data-testid="order-match-excluded">
              {match.tolerance.excludedProducts.map((excluded) => (
                <li key={excluded.productId}>
                  {productNameOf(match, excluded.productId)} — not compared (
                  {EXCLUDED_REASON_COPY[excluded.reason]})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* The pieces of the order the match had NO opinion about. */}
      {match.unmappedLines > 0 && (
        <p className="text-body-sm" data-testid="order-match-unmapped">
          {match.unmappedLines} unmapped line(s), {match.unmappedUnits} units —{" "}
          <Link
            href={UNMAPPED_TAB_HREF}
            className="underline"
            data-testid="order-match-unmapped-link"
          >
            See the mappable ones on the Unmapped tab
          </Link>
          . A line with no store product can&apos;t be mapped and is only counted there.
        </p>
      )}

      {match.unresolvableBundleLines > 0 && (
        <p
          className="text-body-sm text-muted-foreground"
          data-testid="order-match-unresolvable-bundles"
        >
          {match.unresolvableBundleLines} bundle line(s) could not be expanded
        </p>
      )}

      {flagged && (
        <Link
          href={EXCEPTIONS_TAB_HREF}
          className="text-body-sm underline"
          data-testid="order-match-exceptions-link"
        >
          Find this order&apos;s exceptions
        </Link>
      )}
    </div>
  );
}

/**
 * The panel, or the producer's named reason there is none. The pair is
 * EXACTLY-ONE-OF by contract (`attribution.ts`), so the both-null branch is
 * unreachable — and it SAYS SO rather than disappearing if the wire ever
 * disagrees (G2-6). An absent "This order" section reads as "nothing to see
 * here", which is the one thing it must never mean; the row's Match cell has
 * carried this same copy since A3.
 */
function OrderMatchSection({
  match,
  unavailable,
}: {
  match: WireOrderMatch | null;
  unavailable: MatchUnavailableReason | null;
}) {
  if (match !== null) {
    return (
      <Section title="This order">
        <OrderMatchPanel match={match} />
      </Section>
    );
  }
  if (unavailable === null) {
    return (
      <Section title="This order">
        <p
          className="text-body-sm text-muted-foreground"
          data-testid="order-match-not-computed"
        >
          {MATCH_NOT_COMPUTED_COPY}
        </p>
      </Section>
    );
  }
  return (
    <Section title="This order">
      <p
        className="text-body-sm text-muted-foreground"
        data-testid="order-match-unavailable"
        title={MATCH_DEFINITIONS[unavailable]}
      >
        {MATCH_UNAVAILABLE_COPY[unavailable]}
      </p>
    </Section>
  );
}

/**
 * VERBATIM (pack CB2b.4, the OC-1 rule): a fulfilled batch is put back through
 * unfulfill, so the control that would always be refused is not offered — and
 * the sentence says where the repair actually lives.
 */
export const REVERSE_USE_UNFULFILL_COPY =
  "This batch was fulfilled — put it back through unfulfill, not here.";

/**
 * THE MOVE'S TWO "not this batch" SENTENCES (pack CB2c.3, the OC-1 rule —
 * narrowed from three by CB2.5e.3).
 *
 * Each of them names a rung the move ladder would refuse on, so the control is
 * not offered at all — and the sentence says where the repair actually lives
 * rather than leaving a blank an admin reads as "nothing to do here".
 *
 * THERE IS NO FULFILMENT SENTENCE HERE ANY MORE. A fulfilled batch hides BOTH
 * controls, and it used to be told twice, in two spellings, that unfulfill is
 * the repair. `REVERSE_USE_UNFULFILL_COPY` says it once; the move side's own
 * wording survives where operators actually meet it — the move dialog's
 * `MOVE_ORDER_LEG_SENTENCE`.
 *
 * F2 (OC-2): A HIDDEN CONTROL LEAVES ONLY THE SENTENCE, so the sentence names
 * the facts the admin then acts on. "More than one location" sends them back to
 * the ledger to find out WHICH; the ids are already on screen, and the component
 * has already computed both sets to decide the gate.
 */
export const MOVE_MULTI_LOCATION_COPY = (locationIds: number[]): string =>
  `This batch's rows sit at ${locationIds.length} locations (${locationIds.join(', ')}) — ` +
  `it cannot be moved as one`;

export const MOVE_NULL_LOCATION_COPY = (rowIds: number[]): string =>
  `Ledger row ${rowIds.join(', ')} names no location — ` +
  `this batch cannot be reversed or moved until it is repaired`;

export function AttributionDrilldown({
  row,
  open,
  onOpenChange,
  onAttribute,
}: {
  row: AttributionRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttribute: (row: AttributionRow) => void;
}) {
  const detail = useBatchDetail(open ? row.batchId : null);
  const data = detail.data;
  // The confirm panel is this component's own state (pack CB2b.4): the tab hands
  // no prop for it, the way `AttributeConfirm` is reached through the picker.
  const [confirmingReverse, setConfirmingReverse] = React.useState(false);
  const [movingTarget, setMovingTarget] = React.useState<MoveTarget | null>(null);
  // HOISTED (rules of hooks, R6-2): the mutation is declared unconditionally,
  // whatever the gate below decides to render.
  const moveBatch = useMoveBatch(row.batchId);

  // THE LOCATION FACTS, off the DETAIL (pack CB2c.3). `canAttribute` already
  // implies the ledger read was not truncated (the same 50-row bound), so this
  // row set IS the batch and "spans one location" is a fact rather than a guess.
  const ledgerRows = data?.ledgerRows ?? [];
  const detailReady = !detail.isLoading && !detail.isError && data !== undefined;
  // THE IDS, not just the counts (F2): the sentences below name them, so the gate
  // and the copy read the same two sets.
  const nullLocationRowIds = ledgerRows
    .filter((ledgerRow) => ledgerRow.locationId === null)
    .map((ledgerRow) => ledgerRow.id);
  const distinctLocationIds = Array.from(
    new Set(
      ledgerRows
        .map((ledgerRow) => ledgerRow.locationId)
        .filter((locationId): locationId is number => locationId !== null),
    ),
  ).sort((a, b) => a - b);
  const anyNullLocation = nullLocationRowIds.length > 0;
  const spansManyLocations = distinctLocationIds.length > 1;
  const writable = detailReady && row.canAttribute && !row.fulfilled;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Batch {row.batchId}</SheetTitle>
          <SheetDescription>{row.how.sentence}</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {row.fulfilledAgainst !== null && (
            <p className="text-body-sm text-muted-foreground">
              {fulfilledAgainstCopy(row.fulfilledAgainst)}
            </p>
          )}

          {/* CR-1: the R2b lock names an order a sync deleted, so the control
              below cannot render. This is the sentence that says why. */}
          {row.fulfillmentTargetMissing && (
            <p
              className="text-body-sm text-muted-foreground"
              data-testid="drilldown-target-missing"
            >
              {FULFILLMENT_TARGET_MISSING_COPY}
            </p>
          )}

          {row.canAttribute && (
            <Button
              size="sm"
              variant="outline"
              data-testid={`attribute-drilldown-${row.batchId}`}
              onClick={() => onAttribute(row)}
            >
              Attribute…
            </Button>
          )}

          {/* THE REVERSE (Part 2, pack CB2b.4) and THE MOVE (pack CB2c.3). Both
              writer controls wait for the DETAIL: until it loads there are no
              location facts to gate on and no evidence to read, and a control
              offered over a Skeleton is a control offered over nothing (R6-5).

              B2c CLOSES B2b's STATED EXCEPTION: the detail now carries each
              row's location, so a batch with a NULL-location row no longer shows
              either control — it shows the sentence naming the row to repair. */}
          {writable && !anyNullLocation && (
            <Button
              size="sm"
              variant="outline"
              data-testid={`reverse-drilldown-${row.batchId}`}
              onClick={() => setConfirmingReverse(true)}
            >
              Reverse…
            </Button>
          )}

          {/* THE MOVE, beside the reverse — the SAME admissible set (the move
              refuses a fulfilment-evidenced batch too), narrowed by the two
              shapes it cannot reclassify. */}
          {/* F27: and at least ONE row — the handler below reads `ledgerRows[0]`.
              The detail route 404s a batch with no ledger rows, so this arm is
              unreachable today and gets no sentence; the gate is safe by its own
              property rather than by a neighbour route's behaviour. */}
          {writable && !anyNullLocation && !spansManyLocations && ledgerRows.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              data-testid={`move-drilldown-${row.batchId}`}
              onClick={() => {
                const ledgerLocationId = ledgerRows[0].locationId as number;
                // The row's order is a discriminated union: only one arm names a
                // number, and the other two are a redaction and a tombstone.
                const order = row.order;
                const namesOrder = order !== null && "orderNumber" in order;
                setMovingTarget({
                  // The drill-down looks at ONE batch, and it is a manual one by
                  // the gate above: `fulfilBatchId: null` suppresses the dialog's
                  // order-leg line.
                  batchIds: { deductSimpleBatchId: row.batchId, fulfilBatchId: null },
                  ledgerLocationId,
                  ledgerLocationName: ledgerRows[0].locationName ?? `Location ${ledgerLocationId}`,
                  // The batch's outbound Σ as the REPORT read it — the SERVER's
                  // `pairs` decide what actually moved.
                  units: row.units,
                  orderRef: namesOrder ? order.orderNumber : row.batchId,
                  // F13: a uuid introduced as `Order …` is a claim this surface
                  // cannot support — the dialog's header reads the KIND.
                  refKind: namesOrder ? "order" : "batch",
                  caller: "drilldown",
                });
              }}
            >
              Move…
            </Button>
          )}

          {/* CB2.5e.3: ONE sentence for a fulfilled batch, not two. Both controls
              are hidden by the same fact, and it is stated once. */}
          {detailReady && row.fulfilled && (
            <p
              className="text-body-sm text-muted-foreground"
              data-testid="drilldown-reverse-unavailable"
            >
              {REVERSE_USE_UNFULFILL_COPY}
            </p>
          )}

          {detailReady && !row.fulfilled && anyNullLocation && (
            <p
              className="text-body-sm text-muted-foreground"
              data-testid="drilldown-move-null-location"
            >
              {MOVE_NULL_LOCATION_COPY(nullLocationRowIds)}
            </p>
          )}

          {detailReady && !row.fulfilled && !anyNullLocation && spansManyLocations && (
            <p
              className="text-body-sm text-muted-foreground"
              data-testid="drilldown-move-multi-location"
            >
              {MOVE_MULTI_LOCATION_COPY(distinctLocationIds)}
            </p>
          )}

          {confirmingReverse && (
            <ReverseConfirm
              batchId={row.batchId}
              units={row.units}
              productCount={row.productCount}
              onDone={() => setConfirmingReverse(false)}
            />
          )}

          {/* ONE dialog, two callers (pack CB2c.4). The drill-down goes through
              react-query; the workbench passes its own raw-fetch caller. Both
              reject with `{ error, code }`, so the dialog reads a refusal one
              way. */}
          <MoveBatchDialog
            target={movingTarget}
            onOpenChange={(next) => {
              if (!next) setMovingTarget(null);
            }}
            onConfirm={(physicalLocationId) => moveBatch.mutateAsync({ physicalLocationId })}
          />

          {detail.isLoading && <Skeleton className="h-24 w-full" />}
          {detail.isError && (
            <p className="text-body-sm text-negative-foreground">
              This batch&apos;s detail could not be read.
            </p>
          )}

          {data && (
            <>
              <OrderMatchSection
                match={data.orderMatch}
                unavailable={data.orderMatchUnavailable}
              />

              <Section title="Ledger rows">
                <ul className="space-y-1 text-body-sm" data-testid="drilldown-ledger-rows">
                  {data.ledgerRows.map((ledgerRow) => (
                    <li key={ledgerRow.id} className="tabular-nums">
                      {ledgerRow.productName} · {ledgerRow.delta} · {ledgerRow.logType} ·{" "}
                      {ledgerRow.orderRecordId ?? "no order id on this row"}
                    </li>
                  ))}
                </ul>
                {/* The producer bounds this read (OC-8), so the list can be a
                    PAGE of the batch rather than the batch. Saying so is the
                    difference between a short list and a wrong one. */}
                {data.ledgerRowsTruncated && (
                  <p
                    className="text-body-sm text-muted-foreground"
                    data-testid="drilldown-ledger-truncated"
                  >
                    showing the first {data.ledgerRows.length} of this batch&apos;s rows
                  </p>
                )}
              </Section>

              <Section title="The audit event">
                {data.auditEvent === null ? (
                  <p className="text-body-sm text-muted-foreground">
                    No audit event was written under this batch id.
                  </p>
                ) : (
                  <div className="space-y-1 text-body-sm" data-testid="drilldown-audit-event">
                    <p className="text-muted-foreground">{data.auditEvent.label}</p>
                    <p>reference typed: {data.auditEvent.orderReference ?? "none"}</p>
                    <p>intent: {data.auditEvent.intent ?? "none"}</p>
                    <p>order picked: {orderPickedText(data.auditEvent)}</p>
                    {data.auditEvent.orderAttributionSource !== undefined && (
                      <p>
                        stamped from: {stampedFromText(data.auditEvent.orderAttributionSource)}
                      </p>
                    )}
                  </div>
                )}
              </Section>

              <Section title="Recorded attempts">
                {data.attempts.length === 0 ? (
                  <p className="text-body-sm text-muted-foreground">
                    No attempt was recorded for this batch.
                  </p>
                ) : (
                  <ul className="space-y-1 text-body-sm" data-testid="drilldown-attempts">
                    {data.attempts.map((attempt) => (
                      <li key={attempt.id}>
                        {new Date(attempt.attemptedAt).toLocaleString()} · {attempt.outcome} ·{" "}
                        {attempt.evidence ?? attempt.reason ?? "no evidence or reason"} ·{" "}
                        {attempt.source} · {attempt.actor?.username ?? "pipeline"}
                      </li>
                    ))}
                  </ul>
                )}
                {/* CR-4: attempts are APPEND-ONLY, so this list is the newest
                    page of a history that can be longer. The producer bounds it
                    and counts it; saying so is what stops a short list being
                    read as the whole record. */}
                {data.attemptsTruncated && (
                  <p
                    className="text-body-sm text-muted-foreground"
                    data-testid="drilldown-attempts-truncated"
                  >
                    showing the {data.attempts.length} most recent of {data.attemptsCount} attempts
                  </p>
                )}
              </Section>

              <Section title="Manual attributions">
                {data.attributionEvents.length === 0 ? (
                  <p className="text-body-sm text-muted-foreground">
                    This batch has never been attributed by hand.
                  </p>
                ) : (
                  <ul className="space-y-1 text-body-sm" data-testid="drilldown-attribution-events">
                    {data.attributionEvents.map((event) => (
                      <li key={event.id}>
                        {new Date(event.createdAt).toLocaleString()} ·{" "}
                        {event.actor?.username ?? "unknown actor"} · {event.details.rowCount} rows ·{" "}
                        {event.details.previousOrderRecordId ?? "unattributed"} to{" "}
                        {event.details.orderRecordId} ·{" "}
                        {event.details.reason ?? "no reason recorded"}
                      </li>
                    ))}
                  </ul>
                )}
                {data.attributionEventsTruncated && (
                  <p
                    className="text-body-sm text-muted-foreground"
                    data-testid="drilldown-attribution-events-truncated"
                  >
                    showing the {data.attributionEvents.length} most recent of{" "}
                    {data.attributionEventsCount} manual attributions
                  </p>
                )}
              </Section>

              {data.derived !== null && (
                <Section title="Derived at read time">
                  <p className="text-body-sm" data-testid="drilldown-derived">
                    {data.derived.sentence} ({data.derived.ruleId})
                  </p>
                </Section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
