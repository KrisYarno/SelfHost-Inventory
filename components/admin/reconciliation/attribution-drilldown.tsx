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
 *   - THE ATTEMPTS: what was RECORDED live, in order.
 *   - THE ATTRIBUTION EVENTS: manual corrections, with their reasons.
 *
 * And when no attempt was ever recorded, the DERIVED sentence — labelled as
 * derived, with its rule id, so nobody reads a read-time computation as
 * something the pipeline said at the time.
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBatchDetail } from "@/hooks/use-admin";
import type { AttributionRow } from "@/lib/reconciliation/attribution";
import { fulfilledAgainstCopy } from "./attribution-row";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
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
              <Section title="Ledger rows">
                <ul className="space-y-1 text-body-sm" data-testid="drilldown-ledger-rows">
                  {data.ledgerRows.map((ledgerRow) => (
                    <li key={ledgerRow.id} className="tabular-nums">
                      {ledgerRow.productName} · {ledgerRow.delta} · {ledgerRow.logType} ·{" "}
                      {ledgerRow.orderRecordId ?? "no order id on this row"}
                    </li>
                  ))}
                </ul>
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
