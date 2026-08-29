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
import { useBatchDetail } from "@/hooks/use-admin";
import {
  FLAGGED_MATCH_CLASSES,
  MATCH_DEFINITIONS,
  MATCH_UNAVAILABLE_COPY,
  type MatchKind,
  type MatchUnavailableReason,
} from "@/lib/reconciliation/match-keys";
import type { OrderMatch, PerProduct, ToleranceReport } from "@/lib/reconciliation/match";
import type { AttributionRow } from "@/lib/reconciliation/attribution";
import {
  FULFILLMENT_TARGET_MISSING_COPY,
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

/** Integer hundredths in the unit's own scale: 1000 -> "10", 29 -> "0.29". */
function massText(hundredths: number): string {
  return String(Number((hundredths / 100).toFixed(2)));
}

function kindText(product: PerProduct): string {
  return product.kind === null ? "no difference" : `${KIND_COPY[product.kind]} ${product.units}`;
}

/**
 * The product's name, from `perProduct` — the ONLY string inside the match that
 * names anything (pack rule 5). A group member the per-product list does not
 * hold cannot happen (both come from the same rows); it reads as its id rather
 * than as a blank if it ever does.
 */
function productNameOf(match: OrderMatch, productId: number): string {
  const product = match.perProduct.find((row) => row.productId === productId);
  return product === undefined ? `product ${productId}` : product.productName;
}

function memberText(
  match: OrderMatch,
  member: { productId: number; units: number; hundredths: number },
  unit: string,
): string {
  return `${productNameOf(match, member.productId)} x${member.units} @ ${massText(member.hundredths)} ${unit}`;
}

/** One BALANCED group, with the mass it balanced at — the audit of a tolerance. */
function groupText(match: OrderMatch, group: ToleranceReport["equivalentGroups"][number]): string {
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
function OrderMatchPanel({ match }: { match: OrderMatch }) {
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
                <TableCell>{product.productName}</TableCell>
                <TableCell className="tabular-nums">{product.ordered}</TableCell>
                <TableCell className="tabular-nums">{product.deducted}</TableCell>
                <TableCell className="tabular-nums">{product.corrected}</TableCell>
                <TableCell>{kindText(product)}</TableCell>
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
            <p className="font-medium">{product.productName}</p>
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
            <p className="mt-2">{kindText(product)}</p>
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
            Find these unmapped lines
          </Link>
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
 * unreachable — and renders nothing rather than an empty section if the wire
 * ever disagrees.
 */
function OrderMatchSection({
  match,
  unavailable,
}: {
  match: OrderMatch | null;
  unavailable: MatchUnavailableReason | null;
}) {
  if (match !== null) {
    return (
      <Section title="This order">
        <OrderMatchPanel match={match} />
      </Section>
    );
  }
  if (unavailable === null) return null;
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
                    <p>
                      order picked: {data.auditEvent.selectedExternalOrderId ?? "none"}
                    </p>
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
