"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { useLocations } from "@/hooks/use-locations";
import { useProducts } from "@/hooks/use-products";
import {
  useCreateSupplyOrder,
  type CreateSupplyOrderBody,
  type SupplyOrderDetail,
  type SupplyOrderLineInput,
} from "@/hooks/use-supply-orders";
import { lineMoney } from "@/lib/supply-orders/money";

/**
 * ORDER ENTRY (contract pack C4a.3, spec §4.1).
 *
 * The order is entered WHEN IT IS PLACED, so this form is the moment the ledger
 * learns what was bought — and five things about it are load-bearing:
 *
 *   1. THE ORDERED DATE IS A CALENDAR DAY, not an instant. Its default is built
 *      from LOCAL getters and it is submitted as the lexical `YYYY-MM-DD` string
 *      unchanged. The client never constructs a Date from it: `toISOString()` on
 *      a local midnight is YESTERDAY for everyone west of Greenwich, and the
 *      server is the one place that turns the day into UTC midnight.
 *   2. FEES DEFAULT TO 0, NOT NULL. A form submitted without fees genuinely had
 *      none; NULL means "not recorded", which only a later PATCH can say (G1s-12).
 *   3. COST NEVER TRAVELS FROM A LINE. A product created here carries NO
 *      `costPrice` at all — the receipt's own unit cost prices it later, through
 *      the D-COST prompt (premise 1 / D10). The server refuses the field
 *      outright, and this form must never make a user think otherwise.
 *   4. THE MONEY IS DERIVED, NEVER TYPED. The operator enters the TOTAL PAID;
 *      `lineMoney` derives the unit cost and the derivation string travels with
 *      it. A free line ($0.00 total) has NO unit cost — showing "$0.00/unit"
 *      would be a valuation nobody can stand behind.
 *   5. THE PICKER IS UX, NOT AUTHORITY. It offers approved products plus the
 *      operator's own pending ones; `resolveSupplyOrderProduct` on the server is
 *      what actually decides, and it is never bypassed by what is listed here.
 */

// The zod bounds this form mirrors (lib/validation/supply-orders.ts). Client
// validation is a courtesy — the server re-checks every one of them.
const MAX_CENTS = 100_000_000;
const MAX_UNITS = 1_000_000;
const MAX_LINES = 50;

const UNITS = ["mg", "ml", "mcg", "iu"] as const;

interface NewProductFields {
  baseName: string;
  variant: string;
  unit: string;
  numericValue: string;
  lowStockThreshold: string;
  retailPrice: string;
  locationId: string;
  leadTimeDays: string;
  bufferDays: string;
  minOrderQuantity: string;
  reorderPointOverride: string;
}

interface LineDraft {
  uid: string;
  mode: "existing" | "new";
  productId: number | null;
  productName: string;
  search: string;
  fields: NewProductFields;
  orderedQuantity: string;
  totalPaid: string;
  labelingRequired: boolean;
  notes: string;
}

let uidCounter = 0;

function emptyFields(): NewProductFields {
  return {
    baseName: "",
    variant: "",
    unit: "",
    numericValue: "",
    lowStockThreshold: "",
    retailPrice: "",
    locationId: "",
    leadTimeDays: "",
    bufferDays: "",
    minOrderQuantity: "",
    reorderPointOverride: "",
  };
}

function emptyLine(): LineDraft {
  return {
    uid: `line-${++uidCounter}`,
    mode: "existing",
    productId: null,
    productName: "",
    search: "",
    fields: emptyFields(),
    orderedQuantity: "1",
    totalPaid: "",
    labelingRequired: true,
    notes: "",
  };
}

/**
 * Today, from LOCAL getters (rule 1). `toISOString()` is deliberately absent
 * from this file.
 */
function todayLexical(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Dollars typed by a human -> whole cents, WITHOUT floating point. `12.35 * 100`
 * is 1234.9999999999998 in binary floating point, and a cent lost here is a cent
 * the exactness contract in `lineMoney` can never get back.
 */
function parseCents(raw: string): number | null {
  const trimmed = raw.trim().replace(/[$,\s]/g, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function parseInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** "$1,250.00" — display only. */
function formatCents(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const remainder = Math.abs(cents) % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${grouped}.${String(remainder).padStart(2, "0")}`;
}

/** The day must EXIST — `new Date('2026-02-30')` rolls silently into March. */
function isRealCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface SupplyOrderFormProps {
  onCreated?: (order: SupplyOrderDetail) => void;
  onCancel?: () => void;
}

export function SupplyOrderForm({ onCreated, onCancel }: SupplyOrderFormProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const createOrder = useCreateSupplyOrder();

  const [supplier, setSupplier] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [orderedAt, setOrderedAt] = useState(todayLexical);
  const [notes, setNotes] = useState("");
  // Rule 2: the default is a real 0, spelled the way currency is spelled.
  const [fees, setFees] = useState("0.00");
  const [feesNote, setFeesNote] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  const updateLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    );
  };

  const updateFields = (index: number, patch: Partial<NewProductFields>) => {
    setLines((current) =>
      current.map((line, position) =>
        position === index ? { ...line, fields: { ...line.fields, ...patch } } : line,
      ),
    );
  };

  const orderTotalCents = useMemo(
    () => lines.reduce((sum, line) => sum + (parseCents(line.totalPaid) ?? 0), 0),
    [lines],
  );

  /**
   * The whole body, or the first refusal. Building and validating together is
   * deliberate: a validator that walks a different shape than the submitter is
   * a validator that eventually approves something the submitter never sends.
   */
  function buildBody(): { body: CreateSupplyOrderBody } | { error: string } {
    if (!isRealCalendarDay(orderedAt)) {
      return { error: "Ordered date must be a real calendar day (YYYY-MM-DD)." };
    }
    const feesCents = fees.trim() === "" ? 0 : parseCents(fees);
    if (feesCents === null || feesCents > MAX_CENTS) {
      return { error: "Fees must be an amount in dollars and cents (0.00 = none charged)." };
    }
    if (lines.length < 1) return { error: "A supply order needs at least one line." };
    if (lines.length > MAX_LINES) {
      return { error: `A supply order carries at most ${MAX_LINES} lines.` };
    }

    const built: SupplyOrderLineInput[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const label = `Line ${index + 1}`;
      const orderedQuantity = parseInteger(line.orderedQuantity);
      if (orderedQuantity === null || orderedQuantity < 1) {
        return { error: `${label}: ordered units must be at least 1 unit.` };
      }
      if (orderedQuantity > MAX_UNITS) {
        return { error: `${label}: ordered units must be at most ${MAX_UNITS}.` };
      }

      const lineTotalCents = parseCents(line.totalPaid);
      if (lineTotalCents === null) {
        return {
          error: `${label}: enter the total paid in dollars and cents (0.00 = free is a fact).`,
        };
      }
      if (lineTotalCents > MAX_CENTS) {
        return { error: `${label}: the total paid is larger than this ledger records.` };
      }

      let product: SupplyOrderLineInput["product"];
      if (line.mode === "existing") {
        if (line.productId === null) {
          return { error: `${label}: choose a product, or create a new one.` };
        }
        product = { mode: "existing", productId: line.productId };
      } else {
        const fields = line.fields;
        if (!fields.baseName.trim()) return { error: `${label}: the new product needs a name.` };
        if (!fields.variant.trim()) {
          return { error: `${label}: the new product needs a variant label.` };
        }
        const numericValue = parseDecimal(fields.numericValue);
        const unit = fields.unit.trim();
        if (numericValue !== null && !unit) {
          return { error: `${label}: a size needs a unit (mg, ml, mcg or iu) as well as a number.` };
        }
        if (unit && numericValue === null) {
          return { error: `${label}: a unit needs a numeric value as well.` };
        }

        // COST IS ABSENT BY CONSTRUCTION (rule 3): the key is never written, so
        // there is nothing for a later edit to accidentally start sending.
        const productFields: Record<string, unknown> = {
          baseName: fields.baseName.trim(),
          variant: fields.variant.trim(),
        };
        if (unit) productFields.unit = unit;
        if (numericValue !== null) productFields.numericValue = numericValue;
        const threshold = parseInteger(fields.lowStockThreshold);
        if (threshold !== null) productFields.lowStockThreshold = threshold;
        const retailPrice = parseDecimal(fields.retailPrice);
        if (retailPrice !== null) productFields.retailPrice = retailPrice;
        const locationId = parseInteger(fields.locationId);
        if (locationId !== null) productFields.locationId = locationId;

        const reorderConfig: Record<string, number> = {};
        const leadTimeDays = parseInteger(fields.leadTimeDays);
        if (leadTimeDays !== null) reorderConfig.leadTimeDays = leadTimeDays;
        const bufferDays = parseInteger(fields.bufferDays);
        if (bufferDays !== null) reorderConfig.customSafetyStockDays = bufferDays;
        const minOrderQuantity = parseInteger(fields.minOrderQuantity);
        if (minOrderQuantity !== null) reorderConfig.minOrderQuantity = minOrderQuantity;
        const reorderPointOverride = parseInteger(fields.reorderPointOverride);
        if (reorderPointOverride !== null) {
          reorderConfig.reorderPointOverride = reorderPointOverride;
        }
        if (Object.keys(reorderConfig).length > 0) productFields.reorderConfig = reorderConfig;

        product = { mode: "new", productFields };
      }

      built.push({
        product,
        orderedQuantity,
        lineTotalCents,
        labelingRequired: line.labelingRequired,
        ...(line.notes.trim() ? { notes: line.notes.trim() } : {}),
      });
    }

    return {
      body: {
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
        ...(supplierRef.trim() ? { supplierRef: supplierRef.trim() } : {}),
        orderedAt,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        feesCents,
        ...(feesNote.trim() ? { feesNote: feesNote.trim() } : {}),
        lines: built,
      },
    };
  }

  const handleSubmit = async () => {
    setFormError(null);
    const result = buildBody();
    if ("error" in result) {
      setFormError(result.error);
      return;
    }

    try {
      const created = await createOrder.mutateAsync(result.body);
      toast.success("Supply order entered");
      onCreated?.(created);
      if (created && created.model === "supply-order") {
        router.push(`/receiving/${created.id}`);
      }
    } catch (error) {
      // The server's own sentence, verbatim — it names the field it refused.
      const message =
        error instanceof Error ? error.message : "Failed to enter the supply order";
      setFormError(message);
      toast.error(message);
    }
  };

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="supply-order-supplier">Supplier</Label>
          <Input
            id="supply-order-supplier"
            value={supplier}
            maxLength={255}
            onChange={(event) => setSupplier(event.target.value)}
            placeholder="Who the order was placed with"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="supply-order-ref">Supplier reference</Label>
          <Input
            id="supply-order-ref"
            value={supplierRef}
            maxLength={255}
            onChange={(event) => setSupplierRef(event.target.value)}
            placeholder="e.g. PO-2026-0142"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="supply-order-date">Ordered date</Label>
          <Input
            id="supply-order-date"
            type="date"
            value={orderedAt}
            onChange={(event) => setOrderedAt(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="supply-order-fees">Fees</Label>
          <Input
            id="supply-order-fees"
            inputMode="decimal"
            value={fees}
            onChange={(event) => setFees(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Shipping, customs, handling. 0.00 = none charged.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="supply-order-fees-note">Fee note</Label>
          <Input
            id="supply-order-fees-note"
            value={feesNote}
            maxLength={255}
            onChange={(event) => setFeesNote(event.target.value)}
            placeholder="What the fees were for"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="supply-order-notes">Order notes</Label>
          <Textarea
            id="supply-order-notes"
            rows={2}
            maxLength={5000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </section>

      <section className="space-y-3">
        {lines.map((line, index) => (
          <LineEditor
            key={line.uid}
            index={index}
            line={line}
            canRemove={lines.length > 1}
            isAdmin={!!session?.user?.isAdmin}
            sessionUserId={session?.user?.id}
            onChange={(patch) => updateLine(index, patch)}
            onFieldsChange={(patch) => updateFields(index, patch)}
            onRemove={() =>
              setLines((current) => current.filter((_, position) => position !== index))
            }
          />
        ))}

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={lines.length >= MAX_LINES}
          onClick={() => setLines((current) => [...current, emptyLine()])}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add line
        </Button>
      </section>

      <div
        data-testid="order-total"
        className="rounded-lg border border-border bg-surface p-3 text-sm"
      >
        <span className="font-medium">{`Order total ${formatCents(orderTotalCents)}`}</span>
        <span className="text-muted-foreground"> (fees separate)</span>
      </div>

      {formError && (
        <p
          data-testid="supply-order-form-error"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {formError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => onCancel?.()}
          disabled={createOrder.isPending}
        >
          Cancel
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={createOrder.isPending}>
          {createOrder.isPending ? "Saving…" : "Save supply order"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------

interface LineEditorProps {
  index: number;
  line: LineDraft;
  canRemove: boolean;
  isAdmin: boolean;
  sessionUserId: number | undefined;
  onChange: (patch: Partial<LineDraft>) => void;
  onFieldsChange: (patch: Partial<NewProductFields>) => void;
  onRemove: () => void;
}

function LineEditor({
  index,
  line,
  canRemove,
  isAdmin,
  sessionUserId,
  onChange,
  onFieldsChange,
  onRemove,
}: LineEditorProps) {
  const { data: productPage } = useProducts({
    search: line.search,
    page: 1,
    pageSize: 25,
  });
  const { data: locations = [] } = useLocations(line.mode === "new");

  /**
   * The picker's CLIENT-SIDE scope: approved products, plus the operator's own
   * pending ones (they created it, they may order against it). The optimized
   * route returns every non-deleted approval state and does not take an
   * `approvalStatus` filter, so this narrowing happens here — as UX. The server
   * enforces the same rule and is the authority.
   */
  const options = (productPage?.products ?? []).filter(
    (product) =>
      product.approvalStatus === "APPROVED" ||
      (product.approvalStatus === "PENDING_REVIEW" &&
        sessionUserId !== undefined &&
        product.createdBy === sessionUserId),
  );

  const orderedQuantity = parseInteger(line.orderedQuantity);
  const lineTotalCents = parseCents(line.totalPaid);
  const money =
    orderedQuantity !== null && lineTotalCents !== null
      ? lineMoney({ lineTotalCents, orderedQuantity, verifiedQuantity: null })
      : null;

  return (
    <div
      data-testid={`order-line-${index}`}
      className="space-y-3 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{`Line ${index + 1}`}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid={`remove-line-${index}`}
          disabled={!canRemove}
          onClick={onRemove}
          aria-label={`Remove line ${index + 1}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {line.mode === "existing" ? (
        <div className="space-y-2">
          <Label htmlFor={`product-search-${index}`}>Product</Label>
          {line.productId === null ? (
            <>
              <Input
                id={`product-search-${index}`}
                data-testid={`product-search-${index}`}
                value={line.search}
                onChange={(event) => onChange({ search: event.target.value })}
                placeholder="Search the catalog"
              />
              <div
                data-testid={`product-options-${index}`}
                className="max-h-40 space-y-1 overflow-y-auto"
              >
                {options.map((product) => (
                  <Button
                    key={product.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() =>
                      onChange({ productId: product.id, productName: product.name })
                    }
                  >
                    {product.approvalStatus === "PENDING_REVIEW"
                      ? `${product.name} (your pending product)`
                      : product.name}
                  </Button>
                ))}
                {options.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No matching product you can order against — create it below.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate font-medium">{line.productName}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onChange({ productId: null, productName: "" })}
              >
                Change
              </Button>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid={`create-new-product-${index}`}
            onClick={() => onChange({ mode: "new", productId: null, productName: "" })}
          >
            Create new product
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">New product</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange({ mode: "existing" })}
            >
              Choose an existing product
            </Button>
          </div>
          {!isAdmin && (
            <p
              data-testid={`new-product-approval-note-${index}`}
              className="text-xs text-muted-foreground"
            >
              This product will be created (pending review) — you can order against it
              immediately; an admin approves it before anyone else sees it.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`new-product-base-name-${index}`}>Product name</Label>
              <Input
                id={`new-product-base-name-${index}`}
                data-testid={`new-product-base-name-${index}`}
                value={line.fields.baseName}
                maxLength={150}
                onChange={(event) => onFieldsChange({ baseName: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`new-product-variant-${index}`}>Variant label</Label>
              <Input
                id={`new-product-variant-${index}`}
                data-testid={`new-product-variant-${index}`}
                value={line.fields.variant}
                maxLength={100}
                onChange={(event) => onFieldsChange({ variant: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`new-product-numeric-${index}`}>Size</Label>
              <Input
                id={`new-product-numeric-${index}`}
                data-testid={`new-product-numeric-${index}`}
                inputMode="decimal"
                value={line.fields.numericValue}
                onChange={(event) => onFieldsChange({ numericValue: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`new-product-unit-${index}`}>Unit</Label>
              <Select
                value={line.fields.unit || "none"}
                onValueChange={(value) =>
                  onFieldsChange({ unit: value === "none" ? "" : value })
                }
              >
                <SelectTrigger id={`new-product-unit-${index}`}>
                  <SelectValue placeholder="No size" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No size</SelectItem>
                  {UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`new-product-location-${index}`}>Location</Label>
              <Select
                value={line.fields.locationId || undefined}
                onValueChange={(value) => onFieldsChange({ locationId: value })}
              >
                <SelectTrigger id={`new-product-location-${index}`}>
                  <SelectValue placeholder="Default location" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`new-product-retail-${index}`}>Retail price</Label>
              <Input
                id={`new-product-retail-${index}`}
                data-testid={`new-product-retail-${index}`}
                inputMode="decimal"
                value={line.fields.retailPrice}
                onChange={(event) => onFieldsChange({ retailPrice: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`new-product-threshold-${index}`}>Low stock threshold</Label>
              <Input
                id={`new-product-threshold-${index}`}
                data-testid={`new-product-threshold-${index}`}
                inputMode="numeric"
                value={line.fields.lowStockThreshold}
                onChange={(event) =>
                  onFieldsChange({ lowStockThreshold: event.target.value })
                }
              />
            </div>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Reorder settings (optional)
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`new-product-lead-${index}`}>Lead time (days)</Label>
                <Input
                  id={`new-product-lead-${index}`}
                  inputMode="numeric"
                  value={line.fields.leadTimeDays}
                  onChange={(event) => onFieldsChange({ leadTimeDays: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`new-product-buffer-${index}`}>Buffer (days)</Label>
                <Input
                  id={`new-product-buffer-${index}`}
                  inputMode="numeric"
                  value={line.fields.bufferDays}
                  onChange={(event) => onFieldsChange({ bufferDays: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`new-product-moq-${index}`}>Min order quantity</Label>
                <Input
                  id={`new-product-moq-${index}`}
                  inputMode="numeric"
                  value={line.fields.minOrderQuantity}
                  onChange={(event) =>
                    onFieldsChange({ minOrderQuantity: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`new-product-rop-${index}`}>Reorder point override</Label>
                <Input
                  id={`new-product-rop-${index}`}
                  inputMode="numeric"
                  value={line.fields.reorderPointOverride}
                  onChange={(event) =>
                    onFieldsChange({ reorderPointOverride: event.target.value })
                  }
                />
              </div>
            </div>
          </details>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`ordered-units-${index}`}>Ordered units</Label>
          <Input
            id={`ordered-units-${index}`}
            data-testid={`ordered-units-${index}`}
            inputMode="numeric"
            value={line.orderedQuantity}
            onChange={(event) => onChange({ orderedQuantity: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`total-paid-${index}`}>Total paid</Label>
          <Input
            id={`total-paid-${index}`}
            data-testid={`total-paid-${index}`}
            inputMode="decimal"
            value={line.totalPaid}
            onChange={(event) => onChange({ totalPaid: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            What the line actually cost. 0.00 = free is a fact.
          </p>
        </div>
      </div>

      <p data-testid={`line-derivation-${index}`} className="text-xs text-muted-foreground">
        {money === null
          ? "Unit cost appears once ordered units and total paid are entered."
          : (money.derivation ??
            "No unit cost — a free line has none to derive, and a zero valuation is a number nobody can stand behind.")}
      </p>

      <div className="flex items-center gap-2">
        <Checkbox
          id={`labeling-required-${index}`}
          checked={line.labelingRequired}
          onCheckedChange={(checked) => onChange({ labelingRequired: checked === true })}
        />
        <Label htmlFor={`labeling-required-${index}`} className="text-sm font-normal">
          Labeling required before stocking
        </Label>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`line-notes-${index}`}>Line notes</Label>
        <Textarea
          id={`line-notes-${index}`}
          rows={2}
          maxLength={5000}
          value={line.notes}
          onChange={(event) => onChange({ notes: event.target.value })}
        />
      </div>
    </div>
  );
}
