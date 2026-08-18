"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Ban, CheckCircle2, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BatchRow } from "@/components/labeling/batch-row";
import { useLocations } from "@/hooks/use-locations";
import { useProducts } from "@/hooks/use-products";
import {
  useAddLine,
  useDiscardLine,
  usePatchLine,
  usePatchSupplyOrder,
  useResolveException,
  useVerifyLine,
  type ProductSelector,
  type ShipmentApiError,
  type SupplyOrderDetail as SupplyOrderDetailWire,
  type SupplyOrderExceptionView,
  type SupplyOrderLineView,
} from "@/hooks/use-supply-orders";
import { RESOLUTIONS, type Resolution } from "@/lib/exceptions/kinds";

/**
 * THE ORDER DETAIL (contract pack C4b.1, spec §4.2).
 *
 * The whole delivery conversation happens here: an order was placed, boxes
 * turned up, somebody counted them, and what did not add up has to be followed
 * up. Four things this file is careful about:
 *
 *   1. THE CONTROLS FOLLOW THE LINE'S STATUS. An ORDERED line is verified; a
 *      VERIFIED/LABELING/COMPLETE line is adjusted and stocked. A control that
 *      the server would answer with a 409 every single time is not a safety
 *      net, it is a trap — so it is not rendered.
 *   2. A REFUSAL IS SHOWN VERBATIM (C4b.4). The lane's 409s carry the counters
 *      the attempt collided with, read from the LOCKED row; re-wording them
 *      would replace the server's facts with the screen's stale guess. The
 *      caches are already refreshed by the time the message lands (every
 *      mutation invalidates on settle), so the sentence sits next to the new
 *      truth. Nothing is ever resubmitted automatically.
 *   3. NOTHING NUMERIC IS RE-DERIVED. Ordered / verified / stocked / disposed /
 *      remaining, the unit cost and its derivation, the per-line discrepancy —
 *      all arrive computed. A line that is short is short whether or not the
 *      money came out zero, and an unverified line is UNKNOWN, not zero.
 *   4. THE FAST PATH IS THE SHARED ROW (S21). A line with units left mounts the
 *      same `<BatchRow>` the labeling queue mounts, so idempotency and the cost
 *      prompt have exactly one implementation.
 */

type SupplyOrderDetailNewFlow = Extract<SupplyOrderDetailWire, { model: "supply-order" }>;

/** The statuses a line may still be verified from (spec §4.0). */
const VERIFIED_STATUSES = ["VERIFIED", "LABELING", "COMPLETE"];

// ---------------------------------------------------------------------------
// Presentation helpers (display only — every figure arrives pre-computed)
// ---------------------------------------------------------------------------

function formatCents(cents: number | null): string {
  if (cents === null) return "Not priced";
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${String(remainder).padStart(2, "0")}`;
}

/**
 * The ordered DAY, read back in UTC — `orderedAt` is the UTC midnight of a
 * calendar day somebody typed, and local getters would show the day before it
 * to every reader west of Greenwich.
 */
function formatOrderedDay(value: Date | string): string {
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toISOString().slice(0, 10);
}

function formatInstant(value: Date | string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function parseCents(raw: string): number | null {
  const trimmed = raw.trim().replace(/[$,\s]/g, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function parseCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** The server's sentence, or the least-wrong fallback. Never a re-wording. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "ORDERED" || status === "RECEIVING") return "default";
  if (status === "CLOSED" || status === "COMPLETE") return "secondary";
  return "outline";
}

/** The subject's money, whatever kind of row it is. Absent stays absent. */
function subjectNumber(subject: unknown, field: string): number | null {
  if (subject === null || typeof subject !== "object") return null;
  const value = (subject as Record<string, unknown>)[field];
  return typeof value === "number" ? value : null;
}

/**
 * The subject said the field is NULL — a different statement from not having the
 * field at all. A labeling-loss row on an unbilled arrival carries
 * `lossCents: null` on purpose (REV-10 clause 8): the units were lost, what they
 * cost is unknown. A row raised before this lane simply has no such key, and
 * "no money recorded" is the truthful sentence there.
 */
function subjectSaysUnknown(subject: unknown, field: string): boolean {
  if (subject === null || typeof subject !== "object") return false;
  const record = subject as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, field) && record[field] === null;
}

function subjectText(subject: unknown, field: string): string | null {
  if (subject === null || typeof subject !== "object") return null;
  const value = (subject as Record<string, unknown>)[field];
  return typeof value === "string" && value ? value : null;
}

// ---------------------------------------------------------------------------
// The product picker (shared by the substitution panel and "Add arrived line")
// ---------------------------------------------------------------------------

interface ProductPickerProps {
  idPrefix: string;
  selection: ProductSelector | null;
  selectedName: string;
  onSelect: (selector: ProductSelector | null, name: string) => void;
}

/**
 * Choose a product, or create one on the spot. The list is UX ONLY — the server's
 * `resolveSupplyOrderProduct` decides what an operator may point a line at, and
 * a new product carries NO cost (premise 1 / D10: the receipt prices it).
 */
function ProductPicker({ idPrefix, selection, selectedName, onSelect }: ProductPickerProps) {
  const { data: session } = useSession();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [baseName, setBaseName] = useState("");
  const [variant, setVariant] = useState("");

  const { data: productPage } = useProducts({ search, page: 1, pageSize: 25 });
  const sessionUserId = session?.user?.id;
  const options = (productPage?.products ?? []).filter(
    (product) =>
      product.approvalStatus === "APPROVED" ||
      (product.approvalStatus === "PENDING_REVIEW" &&
        sessionUserId !== undefined &&
        product.createdBy === sessionUserId),
  );

  if (selection !== null) {
    return (
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate font-medium">{selectedName}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            onSelect(null, "");
            setCreating(false);
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  if (creating) {
    return (
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-base-name`} className="text-xs">
              New product name
            </Label>
            <Input
              id={`${idPrefix}-base-name`}
              className="h-9"
              value={baseName}
              maxLength={150}
              onChange={(event) => setBaseName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-variant`} className="text-xs">
              Variant
            </Label>
            <Input
              id={`${idPrefix}-variant`}
              className="h-9"
              value={variant}
              maxLength={100}
              onChange={(event) => setVariant(event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The receipt prices it — a product created here carries no cost of its own.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!baseName.trim() || !variant.trim()}
            onClick={() =>
              onSelect(
                {
                  mode: "new",
                  productFields: { baseName: baseName.trim(), variant: variant.trim() },
                },
                `${baseName.trim()} ${variant.trim()}`,
              )
            }
          >
            Use this new product
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
            Pick an existing product
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-search`} className="text-xs">
        Product
      </Label>
      <Input
        id={`${idPrefix}-search`}
        className="h-9"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search the catalog"
      />
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {options.map((product) => (
          <Button
            key={product.id}
            type="button"
            size="sm"
            variant="ghost"
            className="w-full justify-start"
            onClick={() => onSelect({ mode: "existing", productId: product.id }, product.name)}
          >
            {product.approvalStatus === "PENDING_REVIEW"
              ? `${product.name} (your pending product)`
              : product.name}
          </Button>
        ))}
        {options.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No matching product you can use — create it below.
          </p>
        )}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
        Create new product
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------

type LinePanel = "count" | "substitute" | "edit" | "discard" | null;

interface LineCardProps {
  orderId: string;
  line: SupplyOrderLineView;
  locations: { id: number; name: string }[];
  blocked: boolean;
}

function LineCard({ orderId, line, locations, blocked }: LineCardProps) {
  const verifyLine = useVerifyLine(orderId);
  const patchLine = usePatchLine(orderId);
  const discardLine = useDiscardLine(orderId);

  const [panel, setPanel] = useState<LinePanel>(null);
  const [count, setCount] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [substitute, setSubstitute] = useState<ProductSelector | null>(null);
  const [substituteName, setSubstituteName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  const isOrdered = line.status === "ORDERED";
  const isVerified = VERIFIED_STATUSES.includes(line.status);
  const canBook = isVerified && line.remaining > 0;
  // The labeling flag travels by PATCH while the line is ORDERED and by a
  // FLAG-ONLY verify afterwards (C4b.1 / REV-10 clause 2). The flag stops
  // moving once the line is COMPLETE: the bench has finished with it, and
  // re-tagging something already stocked says nothing about the work.
  const canRetagLabeling =
    (line.status === "VERIFIED" || line.status === "LABELING") &&
    line.verifiedQuantity !== null;
  // REMOVING THE LINE (REV-10 clause 3). An ORDERED line never arrived; a
  // VERIFIED line with both counters at 0 is the unordered-arrival duplicate —
  // born verified, so an ORDERED-only rule left it on the order forever.
  const canRemoveLine =
    isOrdered ||
    (line.status === "VERIFIED" && line.stockedQuantity === 0 && line.disposedQuantity === 0);

  const closePanel = () => {
    setPanel(null);
    setCount("");
    setNote("");
    setReason("");
    setSubstitute(null);
    setSubstituteName("");
  };

  const runVerify = async (body: Record<string, unknown>, success: string) => {
    setRefusal(null);
    try {
      await verifyLine.mutateAsync({
        lineId: line.id,
        body: body as never,
      });
      toast.success(success);
      closePanel();
    } catch (error) {
      setRefusal(messageOf(error as ShipmentApiError, "Failed to record the count"));
    }
  };

  const submitCount = async () => {
    const typed = parseCount(count);
    if (typed === null) return;
    // A typo guard, NOT a veto: "nothing arrived" is a real fact about the dock,
    // and the line stays re-openable by a later raise (G1s-15).
    if (
      typed === 0 &&
      !window.confirm(
        "Nothing arrived for this line — record a verified count of 0? A later delivery can still raise it.",
      )
    ) {
      return;
    }
    await runVerify(
      {
        verifiedQuantity: typed,
        // THE COUNT THIS CARD IS SHOWING (REV-10 clause 1). An adjustment is an
        // opinion about a specific previous number; if that number has moved,
        // the server refuses rather than re-classifying somebody else's count.
        expectPrevious: line.verifiedQuantity,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(panel === "substitute" && substitute ? { deliveredProduct: substitute } : {}),
      },
      `Counted ${typed}`,
    );
  };

  const submitMatches = async () => {
    if (line.orderedQuantity === null) return;
    await runVerify(
      // NULL is the assertion this button actually makes: "nothing has been
      // counted on this line". A colleague who counted while the tab sat open
      // makes it false, and the server says so.
      { verifiedQuantity: line.orderedQuantity, expectPrevious: null },
      `Counted ${line.orderedQuantity}`,
    );
  };

  const submitEdit = async (patch: Record<string, unknown>) => {
    setRefusal(null);
    try {
      await patchLine.mutateAsync({ lineId: line.id, body: patch as never });
      toast.success("Line updated");
      closePanel();
    } catch (error) {
      setRefusal(messageOf(error as ShipmentApiError, "Failed to update the line"));
    }
  };

  const submitDiscard = async () => {
    setRefusal(null);
    try {
      await discardLine.mutateAsync({
        lineId: line.id,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success("Line removed from the order");
      closePanel();
    } catch (error) {
      setRefusal(messageOf(error as ShipmentApiError, "Failed to remove the line"));
    }
  };

  const discrepancyCell = (): string => {
    if (line.verifiedQuantity === null) return "Not verified yet";
    const discrepancy = line.discrepancy;
    if (discrepancy === null) return "Matches the order";
    const parts: string[] = [];
    if (discrepancy.unordered) parts.push("unordered arrival");
    if (discrepancy.shortUnits > 0) {
      parts.push(`${discrepancy.shortUnits} short · ${formatCents(discrepancy.lossCents)} loss`);
    }
    if (discrepancy.overUnits > 0) {
      parts.push(
        `${discrepancy.overUnits} over · ${formatCents(discrepancy.surplusValueCents)} surplus`,
      );
    }
    return parts.length > 0 ? parts.join(" · ") : "Matches the order";
  };

  return (
    <li
      data-testid={`supply-order-line-${line.id}`}
      data-blocked={blocked ? "true" : undefined}
      className={`space-y-3 rounded-lg border bg-surface p-3 ${
        blocked ? "border-destructive/60" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{line.productName}</p>
          {line.orderedProductId !== null &&
            line.productId !== null &&
            line.orderedProductId !== line.productId && (
              <p className="text-xs text-muted-foreground">
                {`ordered as: ${
                  line.orderedProductName ?? `product #${line.orderedProductId}`
                } — re-mapped to what arrived`}
              </p>
            )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={statusVariant(line.status)}>{line.status}</Badge>
            <span>
              {line.labelingRequired ? "Labeling required" : "Ready to stock (skips labeling)"}
            </span>
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p data-testid={`line-cost-${line.id}`}>{formatCents(line.unitCostCents)}</p>
          {line.derivation && <p>{line.derivation}</p>}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <div>
          <dt className="text-xs text-muted-foreground">Ordered</dt>
          <dd className="tabular-nums">{line.orderedQuantity ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Verified</dt>
          <dd className="tabular-nums">{line.verifiedQuantity ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Stocked</dt>
          <dd className="tabular-nums">{line.stockedQuantity}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Disposed</dt>
          <dd className="tabular-nums">{line.disposedQuantity}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Remaining</dt>
          <dd className="tabular-nums">{line.remaining}</dd>
        </div>
      </dl>

      <p data-testid={`line-discrepancy-${line.id}`} className="text-xs font-medium">
        {discrepancyCell()}
      </p>

      <div className="flex flex-wrap gap-2">
        {isOrdered && line.orderedQuantity !== null && (
          <Button size="sm" onClick={submitMatches} disabled={verifyLine.isPending}>
            <CheckCircle2 className="mr-1 h-4 w-4" />
            {`Counted ${line.orderedQuantity} — matches order`}
          </Button>
        )}
        {(isOrdered || isVerified) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPanel(panel === "count" ? null : "count")}
          >
            {isOrdered ? "Enter discrepancy" : "Adjust count"}
          </Button>
        )}
        {isOrdered && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPanel(panel === "substitute" ? null : "substitute")}
          >
            Different product arrived
          </Button>
        )}
        {canRetagLabeling && (
          <Button
            size="sm"
            variant="ghost"
            disabled={verifyLine.isPending}
            onClick={() =>
              runVerify(
                // FLAG ONLY (REV-10 clause 2) — no count is sent, so nothing
                // about the count can move. `expectPrevious` still travels: the
                // flag belongs to the line the operator was looking at.
                {
                  labelingRequired: !line.labelingRequired,
                  expectPrevious: line.verifiedQuantity,
                },
                line.labelingRequired
                  ? "This line is ready to stock"
                  : "This line goes to the bench",
              )
            }
          >
            {line.labelingRequired ? "Skip labeling" : "Require labeling"}
          </Button>
        )}
        {isOrdered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPanel(panel === "edit" ? null : "edit")}
          >
            <Pencil className="mr-1 h-4 w-4" />
            Edit line
          </Button>
        )}
        {canRemoveLine && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPanel(panel === "discard" ? null : "discard")}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            Remove line
          </Button>
        )}
      </div>

      {(panel === "count" || panel === "substitute") && (
        <div
          data-testid={`line-count-panel-${line.id}`}
          className="space-y-2 rounded-md border border-border p-3"
        >
          {panel === "substitute" && (
            <>
              <p className="text-xs text-muted-foreground">
                A substitution re-maps this line — an EXTRA product is &quot;Add arrived
                line&quot;.
              </p>
              <ProductPicker
                idPrefix={`line-${line.id}-substitute`}
                selection={substitute}
                selectedName={substituteName}
                onSelect={(selector, name) => {
                  setSubstitute(selector);
                  setSubstituteName(name);
                }}
              />
            </>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`line-${line.id}-count`} className="text-xs">
                Counted units
              </Label>
              <Input
                id={`line-${line.id}-count`}
                inputMode="numeric"
                className="h-9"
                value={count}
                onChange={(event) => setCount(event.target.value)}
                placeholder="Units on the dock"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`line-${line.id}-note`} className="text-xs">
                Note
              </Label>
              <Input
                id={`line-${line.id}-note`}
                className="h-9"
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What the dock saw"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={submitCount}
              disabled={
                parseCount(count) === null ||
                verifyLine.isPending ||
                (panel === "substitute" && substitute === null)
              }
            >
              Record count
            </Button>
            <Button size="sm" variant="ghost" onClick={closePanel}>
              Cancel
            </Button>
          </div>
          {isVerified && (
            <p className="text-xs text-muted-foreground">
              A later delivery raises this count; it can never go below what is already
              stocked and disposed.
            </p>
          )}
        </div>
      )}

      {panel === "edit" && (
        <LineEditPanel
          line={line}
          busy={patchLine.isPending}
          onCancel={closePanel}
          onSubmit={submitEdit}
        />
      )}

      {panel === "discard" && (
        <div className="space-y-2 rounded-md border border-border p-3">
          {!isOrdered && (
            <p className="text-xs text-muted-foreground">
              This removes this arrived line and closes its discrepancy — only for a line
              added by mistake.
            </p>
          )}
          <Label htmlFor={`line-${line.id}-reason`} className="text-xs">
            Why is the line coming off the order?
          </Label>
          <Input
            id={`line-${line.id}-reason`}
            className="h-9"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Optional"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={submitDiscard} disabled={discardLine.isPending}>
              Remove it
            </Button>
            <Button size="sm" variant="ghost" onClick={closePanel}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {canBook && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            {line.labelingRequired
              ? "Stock a labeled batch"
              : "Ready to stock — no labeling needed"}
          </p>
          <BatchRow
            orderId={orderId}
            lineId={line.id}
            remaining={line.remaining}
            priorLocationId={line.locationId}
            locations={locations}
          />
        </div>
      )}

      {refusal && (
        <p
          data-testid={`line-refusal-${line.id}`}
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          {refusal}
        </p>
      )}
    </li>
  );
}

interface LineEditPanelProps {
  line: SupplyOrderLineView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (patch: Record<string, unknown>) => void;
}

/** Editing an ORDERED line: what was ordered, what it cost, whether it labels. */
function LineEditPanel({ line, busy, onCancel, onSubmit }: LineEditPanelProps) {
  const [ordered, setOrdered] = useState(
    line.orderedQuantity === null ? "" : String(line.orderedQuantity),
  );
  const [total, setTotal] = useState(
    line.lineTotalCents === null ? "" : (line.lineTotalCents / 100).toFixed(2),
  );
  const [labeling, setLabeling] = useState(line.labelingRequired);

  const orderedQuantity = parseCount(ordered);
  const lineTotalCents = parseCents(total);

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`line-${line.id}-ordered`} className="text-xs">
            Ordered units
          </Label>
          <Input
            id={`line-${line.id}-ordered`}
            inputMode="numeric"
            className="h-9"
            value={ordered}
            onChange={(event) => setOrdered(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`line-${line.id}-total`} className="text-xs">
            Total paid
          </Label>
          <Input
            id={`line-${line.id}-total`}
            inputMode="decimal"
            className="h-9"
            value={total}
            onChange={(event) => setTotal(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">0.00 = free is a fact.</p>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={labeling}
          onCheckedChange={(checked) => setLabeling(checked === true)}
          aria-label="Labeling required"
        />
        Labeling required
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || (orderedQuantity === null && lineTotalCents === null)}
          onClick={() =>
            onSubmit({
              ...(orderedQuantity !== null && orderedQuantity !== line.orderedQuantity
                ? { orderedQuantity }
                : {}),
              ...(lineTotalCents !== null && lineTotalCents !== line.lineTotalCents
                ? { lineTotalCents }
                : {}),
              ...(labeling !== line.labelingRequired ? { labelingRequired: labeling } : {}),
            })
          }
        >
          Save line
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

interface ExceptionRowProps {
  orderId: string;
  exception: SupplyOrderExceptionView;
}

function ExceptionRow({ orderId, exception }: ExceptionRowProps) {
  const resolveException = useResolveException(orderId);
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution | "">("");
  const [note, setNote] = useState("");
  const [relatedShipmentId, setRelatedShipmentId] = useState("");
  const [creditRef, setCreditRef] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  const lossCents = subjectNumber(exception.subject, "lossCents");
  const lossUnpriced = subjectSaysUnknown(exception.subject, "lossCents");
  const surplusCents = subjectNumber(exception.subject, "surplusValueCents");
  const units = subjectNumber(exception.subject, "units");
  const reason = subjectText(exception.subject, "reason");

  const submit = async () => {
    if (resolution === "") return;
    setRefusal(null);
    try {
      await resolveException.mutateAsync({
        lineId: exception.lineId,
        exceptionKey: exception.key,
        resolution,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(resolution === "reshipped" && relatedShipmentId.trim()
          ? { relatedShipmentId: relatedShipmentId.trim() }
          : {}),
        ...(resolution === "supplier-credited" && creditRef.trim()
          ? { creditRef: creditRef.trim() }
          : {}),
      });
      toast.success("Follow-up recorded");
      setOpen(false);
    } catch (error) {
      setRefusal(messageOf(error as ShipmentApiError, "Failed to settle the exception"));
    }
  };

  return (
    <li
      data-testid={`exception-${exception.key}`}
      className="space-y-2 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">{exception.kind}</Badge>
            <span className="text-muted-foreground">{`line ${exception.lineId}`}</span>
            {exception.resolvedAt === null ? (
              <span className="font-medium text-amber-700 dark:text-amber-400">Open</span>
            ) : (
              <span className="text-muted-foreground">
                {`Resolved ${exception.resolution ?? "—"} · ${formatInstant(exception.resolvedAt)}`}
              </span>
            )}
          </div>
          <p className="text-sm">
            {[
              units !== null ? `${units} unit(s)` : null,
              lossCents !== null ? `${formatCents(lossCents)} loss` : null,
              // NOT $0.00 (REV-10 clause 8): an unbilled arrival's loss is a
              // real loss of an unknown amount, and the row says so.
              lossUnpriced ? "Not priced" : null,
              surplusCents !== null && surplusCents > 0
                ? `${formatCents(surplusCents)} surplus`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No money recorded on this row"}
          </p>
          {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
          {exception.note && <p className="text-xs text-muted-foreground">{exception.note}</p>}
          {exception.kind === "labeling-loss" && (
            <p className="text-xs text-muted-foreground">
              Before stock-in a loss is a labeling loss; after stock-in it is an inventory
              adjustment (DAMAGE) on the product.
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((prev) => !prev)}>
          Resolve
        </Button>
      </div>

      {open && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="space-y-1.5">
            <Label htmlFor={`resolution-${exception.key}`} className="text-xs">
              Resolution
            </Label>
            <Select
              value={resolution === "" ? undefined : resolution}
              onValueChange={(value) => setResolution(value as Resolution)}
            >
              <SelectTrigger
                id={`resolution-${exception.key}`}
                className="h-9"
                aria-label="Resolution"
              >
                <SelectValue placeholder="How was it settled?" />
              </SelectTrigger>
              <SelectContent>
                {RESOLUTIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {resolution === "reshipped" && (
            <div className="space-y-1.5">
              <Label htmlFor={`related-${exception.key}`} className="text-xs">
                Reshipment order
              </Label>
              <Input
                id={`related-${exception.key}`}
                className="h-9"
                value={relatedShipmentId}
                onChange={(event) => setRelatedShipmentId(event.target.value)}
                placeholder="The order the replacement arrived on"
              />
            </div>
          )}

          {resolution === "supplier-credited" && (
            <div className="space-y-1.5">
              <Label htmlFor={`credit-${exception.key}`} className="text-xs">
                Credit reference
              </Label>
              <Input
                id={`credit-${exception.key}`}
                className="h-9"
                value={creditRef}
                maxLength={100}
                onChange={(event) => setCreditRef(event.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`note-${exception.key}`} className="text-xs">
              Note
            </Label>
            <Input
              id={`note-${exception.key}`}
              className="h-9"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={submit}
              disabled={resolution === "" || resolveException.isPending}
            >
              Settle
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {refusal && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
          {refusal}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------

export interface SupplyOrderDetailProps {
  detail: SupplyOrderDetailNewFlow;
}

export function SupplyOrderDetail({ detail }: SupplyOrderDetailProps) {
  const patchOrder = usePatchSupplyOrder(detail.id);
  const addLine = useAddLine(detail.id);
  const { data: locations = [] } = useLocations();

  const [refusal, setRefusal] = useState<string | null>(null);
  const [blockedLineIds, setBlockedLineIds] = useState<number[]>([]);
  const [editing, setEditing] = useState(false);
  const [addingLine, setAddingLine] = useState(false);

  const [supplier, setSupplier] = useState(detail.supplier ?? "");
  const [supplierRef, setSupplierRef] = useState(detail.supplierRef ?? "");
  const [orderedAt, setOrderedAt] = useState(formatOrderedDay(detail.orderedAt));
  const [notes, setNotes] = useState(detail.notes ?? "");
  const [fees, setFees] = useState(
    detail.feesCents === null ? "" : (detail.feesCents / 100).toFixed(2),
  );
  const [feesNote, setFeesNote] = useState(detail.feesNote ?? "");

  const remaining = useMemo(
    () => detail.lines.reduce((sum, line) => sum + line.remaining, 0),
    [detail.lines],
  );

  const isOrdered = detail.status === "ORDERED";
  const isReceiving = detail.status === "RECEIVING";
  const editable = isOrdered || isReceiving;
  // An unordered arrival lands on an order that is already taking delivery, or
  // on one that has closed — never on one where nothing has been verified yet.
  const canAddArrived = isReceiving || detail.status === "CLOSED";

  const handleClose = async () => {
    setRefusal(null);
    setBlockedLineIds([]);
    try {
      await patchOrder.mutateAsync({ action: "close" });
      toast.success("Order closed");
    } catch (error) {
      const apiError = error as ShipmentApiError;
      // The refusal NAMES the lines; the sentence is the server's, and the ids
      // only add a highlight (C4b.4 — they never replace the text).
      const named = apiError?.details?.lineIds;
      if (Array.isArray(named)) setBlockedLineIds(named as number[]);
      setRefusal(messageOf(apiError, "Failed to close the order"));
    }
  };

  const handleCancel = async () => {
    if (
      !window.confirm(
        "Cancel this order? Every ordered line is discarded and the order is closed as cancelled.",
      )
    ) {
      return;
    }
    setRefusal(null);
    setBlockedLineIds([]);
    try {
      await patchOrder.mutateAsync({ action: "cancel" });
      toast.success("Order cancelled");
    } catch (error) {
      setRefusal(messageOf(error as ShipmentApiError, "Failed to cancel the order"));
    }
  };

  const handleSaveHeader = async () => {
    setRefusal(null);
    const feesCents = fees.trim() === "" ? null : parseCents(fees);
    if (fees.trim() !== "" && feesCents === null) {
      setRefusal("Fees must be an amount in dollars and cents (0.00 = none charged).");
      return;
    }
    try {
      await patchOrder.mutateAsync({
        supplier: supplier.trim() === "" ? null : supplier.trim(),
        supplierRef: supplierRef.trim() === "" ? null : supplierRef.trim(),
        orderedAt,
        notes: notes.trim() === "" ? null : notes.trim(),
        feesCents,
        feesNote: feesNote.trim() === "" ? null : feesNote.trim(),
      });
      toast.success("Order updated");
      setEditing(false);
    } catch (error) {
      setRefusal(messageOf(error as ShipmentApiError, "Failed to update the order"));
    }
  };

  return (
    <div className="space-y-6">
      <div
        data-testid="supply-order-header"
        className="space-y-3 rounded-lg border border-border bg-surface p-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 className="truncate text-lg font-semibold">
              {detail.supplierRef ?? detail.id}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={statusVariant(detail.status)}>{detail.status}</Badge>
              <span>{detail.supplier ?? "Supplier not recorded"}</span>
              <span>{`Ordered ${formatOrderedDay(detail.orderedAt)}`}</span>
              {detail.creator && <span>{`entered by ${detail.creator.username}`}</span>}
              {detail.closedAt && (
                <span>
                  {`closed ${formatInstant(detail.closedAt)}${
                    detail.closedBy !== null ? ` by user ${detail.closedBy}` : ""
                  }`}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {detail.feesCents === null
                ? "Fees not recorded"
                : `Fees ${formatCents(detail.feesCents)}${
                    detail.feesNote ? ` — ${detail.feesNote}` : ""
                  }`}
            </p>
            {detail.notes && <p className="text-sm text-muted-foreground">{detail.notes}</p>}
          </div>

          <div className="flex flex-wrap gap-2">
            {remaining > 0 && (
              <Button asChild size="sm" variant="secondary">
                <Link href={`/labeling?orderId=${detail.id}`}>
                  <Tag className="mr-1 h-4 w-4" />
                  Label now
                </Link>
              </Button>
            )}
            {editable && (
              <Button size="sm" variant="ghost" onClick={() => setEditing((prev) => !prev)}>
                <Pencil className="mr-1 h-4 w-4" />
                Edit order
              </Button>
            )}
            {isReceiving && (
              <Button size="sm" onClick={handleClose} disabled={patchOrder.isPending}>
                <CheckCircle2 className="mr-1 h-4 w-4" />
                Close order
              </Button>
            )}
            {isOrdered && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancel}
                disabled={patchOrder.isPending}
              >
                <Ban className="mr-1 h-4 w-4" />
                Cancel order
              </Button>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Lines</dt>
            <dd className="font-medium tabular-nums">{detail.lines.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Verified units</dt>
            <dd className="font-medium tabular-nums">{detail.units.verified}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Stocked units</dt>
            <dd className="font-medium tabular-nums">{detail.units.stocked}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Disposed units</dt>
            <dd className="font-medium tabular-nums">{detail.units.disposed}</dd>
          </div>
        </dl>

        {editing && (
          <div data-testid="order-edit-panel" className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="order-supplier" className="text-xs">
                Supplier
              </Label>
              <Input
                id="order-supplier"
                className="h-9"
                value={supplier}
                maxLength={255}
                onChange={(event) => setSupplier(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="order-ref" className="text-xs">
                Supplier reference
              </Label>
              <Input
                id="order-ref"
                className="h-9"
                value={supplierRef}
                maxLength={255}
                onChange={(event) => setSupplierRef(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="order-date" className="text-xs">
                Ordered date
              </Label>
              <Input
                id="order-date"
                type="date"
                className="h-9"
                value={orderedAt}
                onChange={(event) => setOrderedAt(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="order-fees" className="text-xs">
                Fees
              </Label>
              <Input
                id="order-fees"
                inputMode="decimal"
                className="h-9"
                value={fees}
                onChange={(event) => setFees(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Blank = not recorded. 0.00 = none charged.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="order-fees-note" className="text-xs">
                Fee note
              </Label>
              <Input
                id="order-fees-note"
                className="h-9"
                value={feesNote}
                maxLength={255}
                onChange={(event) => setFeesNote(event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="order-notes" className="text-xs">
                Order notes
              </Label>
              <Textarea
                id="order-notes"
                rows={2}
                maxLength={5000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button size="sm" onClick={handleSaveHeader} disabled={patchOrder.isPending}>
                Save order
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {refusal && (
          <p
            data-testid="order-refusal"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {refusal}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Lines</h3>
          {canAddArrived && (
            <Button size="sm" variant="outline" onClick={() => setAddingLine((prev) => !prev)}>
              <Plus className="mr-1 h-4 w-4" />
              Add arrived line
            </Button>
          )}
        </div>

        {addingLine && (
          <AddArrivedLinePanel
            busy={addLine.isPending}
            onCancel={() => setAddingLine(false)}
            onSubmit={async (body) => {
              setRefusal(null);
              try {
                await addLine.mutateAsync(body as never);
                toast.success("Arrived line added");
                setAddingLine(false);
              } catch (error) {
                setRefusal(messageOf(error as ShipmentApiError, "Failed to add the line"));
              }
            }}
          />
        )}

        {detail.lines.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
            This order has no lines.
          </p>
        ) : (
          <ul className="space-y-3">
            {detail.lines.map((line) => (
              <LineCard
                key={line.id}
                orderId={detail.id}
                line={line}
                locations={locations}
                blocked={blockedLineIds.includes(line.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <div data-testid="follow-up-panel" className="space-y-3">
        <h3 className="text-sm font-semibold">Follow-up</h3>
        {detail.exceptions.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
            Nothing to follow up — discrepancies and labeling losses land here.
          </p>
        ) : (
          <ul className="space-y-3">
            {detail.exceptions.map((exception) => (
              <ExceptionRow key={exception.key} orderId={detail.id} exception={exception} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface AddArrivedLinePanelProps {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}

/**
 * AN UNORDERED ARRIVAL (spec §4.2.5): something turned up that was never on the
 * order. It is created already VERIFIED with NO ordered quantity — its own
 * arrival is the money basis — and a blank total is a real NULL, not a zero.
 */
function AddArrivedLinePanel({ busy, onCancel, onSubmit }: AddArrivedLinePanelProps) {
  const [product, setProduct] = useState<ProductSelector | null>(null);
  const [productName, setProductName] = useState("");
  const [count, setCount] = useState("");
  const [total, setTotal] = useState("");
  const [labeling, setLabeling] = useState(true);
  const [note, setNote] = useState("");

  const verifiedQuantity = parseCount(count);
  const lineTotalCents = total.trim() === "" ? null : parseCents(total);
  const totalInvalid = total.trim() !== "" && lineTotalCents === null;

  return (
    <div
      data-testid="add-arrived-line"
      className="space-y-3 rounded-lg border border-border bg-surface p-3"
    >
      <p className="text-xs text-muted-foreground">
        Only for a product that was NOT on the order — a wrong product that replaced an
        ordered one is &quot;Different product arrived&quot; on that line.
      </p>

      <ProductPicker
        idPrefix="arrived"
        selection={product}
        selectedName={productName}
        onSelect={(selector, name) => {
          setProduct(selector);
          setProductName(name);
        }}
      />

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="arrived-count" className="text-xs">
            Counted units
          </Label>
          <Input
            id="arrived-count"
            inputMode="numeric"
            className="h-9"
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="arrived-total" className="text-xs">
            Total paid
          </Label>
          <Input
            id="arrived-total"
            inputMode="decimal"
            className="h-9"
            value={total}
            onChange={(event) => setTotal(event.target.value)}
            placeholder="Blank = not billed"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="arrived-note" className="text-xs">
            Note
          </Label>
          <Input
            id="arrived-note"
            className="h-9"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={labeling}
          onCheckedChange={(checked) => setLabeling(checked === true)}
          aria-label="Labeling required"
        />
        Labeling required
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || product === null || verifiedQuantity === null || totalInvalid}
          onClick={() => {
            if (product === null || verifiedQuantity === null) return;
            onSubmit({
              product,
              verifiedQuantity,
              ...(lineTotalCents !== null ? { lineTotalCents } : {}),
              labelingRequired: labeling,
              ...(note.trim() ? { note: note.trim() } : {}),
            });
          }}
        >
          Add line
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
