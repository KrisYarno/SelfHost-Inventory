"use client";

import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLegacyLines } from "@/hooks/use-receiving-legacy";

/**
 * THE PRE-STAGING ARCHIVE (contract pack C5.2, spec §4.3.6 / D8).
 *
 * The boxes of the flow this lane replaces, kept for exactly one reason: the
 * rows are kept, and a receipt somebody is asked about next year has to be
 * findable. It is READ-ONLY by construction — no count, no graduate, no
 * discard, not even a disabled one. An affordance whose only possible answer is
 * a refusal teaches people that refusals are noise.
 *
 * What is MISSING is named rather than blanked: a box with no resolved product
 * says so, and a location whose name did not come back is shown by its id. An
 * empty cell in an archive reads as "nothing was there", which is a different
 * claim from "this was never recorded".
 */

/** A legacy receipt's INSTANT — a real moment, shown in local time. */
function formatInstant(value: Date | string): string {
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

export function LegacyLinesList() {
  const { data: lines = [], isPending, isError, error } = useLegacyLines();

  return (
    <div className="space-y-4">
      {isPending && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading the history…
        </div>
      )}

      {isError && (
        <div
          data-testid="legacy-lines-error"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">The pre-staging history could not be loaded.</p>
            <p className="text-muted-foreground">
              {error?.message ?? "Reload the page to try again."}
            </p>
          </div>
        </div>
      )}

      {!isPending && !isError && lines.length === 0 && (
        <div
          data-testid="legacy-lines-empty"
          className="rounded-lg border border-border bg-surface p-8 text-center"
        >
          <p className="text-sm text-muted-foreground">
            No pre-staging history — the retired flow logged no boxes.
          </p>
        </div>
      )}

      {!isPending && !isError && lines.length > 0 && (
        <ul className="space-y-2">
          {lines.map((line) => (
            <li
              key={line.id}
              data-testid={`legacy-line-${line.id}`}
              className="space-y-1 rounded-lg border border-border bg-surface p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 truncate font-medium">{line.description}</p>
                <Badge variant={line.status === "GRADUATED" ? "secondary" : "outline"}>
                  {line.status}
                </Badge>
              </div>

              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <div className="flex gap-1">
                  <dt>Product</dt>
                  <dd className="text-foreground">
                    {line.productName ?? "No product linked"}
                  </dd>
                </div>
                <div className="flex gap-1">
                  <dt>Location</dt>
                  <dd className="text-foreground">
                    {line.locationName ?? `Location ${line.locationId}`}
                  </dd>
                </div>
              </dl>

              <p
                data-testid={`legacy-received-${line.id}`}
                className="text-xs text-muted-foreground"
              >
                {`Received ${formatInstant(line.receivedAt)} by user ${line.receivedBy}`}
              </p>

              {/* The receipt link exists only when the box was attributed to
                  one — an orphan box is history on its own terms. */}
              {line.shipmentId !== null && (
                <Link
                  href={`/receiving/${line.shipmentId}`}
                  className="inline-block text-xs font-medium hover:underline"
                >
                  Open the receipt
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
