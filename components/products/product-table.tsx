"use client";

import { useState } from "react";
import type { ProductWithQuantity } from "@/types/product";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProductStock } from "./product-stock";
import { ProductActionsMenu } from "./product-actions-menu";

interface ProductActions {
  isAdmin: boolean;
  onAdjust: (product: ProductWithQuantity) => void;
  onStockIn: (product: ProductWithQuantity) => void;
  onEdit?: (product: ProductWithQuantity) => void;
  onDelete?: (product: ProductWithQuantity) => void;
}

interface ProductTableProps extends ProductActions {
  products: ProductWithQuantity[];
  /** The answer's `hereLocationId` echo. */
  hereLocationId: number | null | undefined;
  /** The CONFIRMED location, or null. */
  selectedLocation: { id: number; name: string } | null;
}

/** Cost / Retail: `$` with 2 decimals; `null` is "Not set" (B10: every approved user sees them). */
function Price({ value }: { value: ProductWithQuantity["costPrice"] | undefined }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">Not set</span>;
  }
  return <>${Number(value).toFixed(2)}</>;
}

/**
 * The List view at `lg` and up (facelift F2-8, A15, B10). The rows are not
 * clickable; each product's actions are through its "…" menu. The `Here` column
 * is OMITTED with no confirmed location, or when the answer's `hereLocationId`
 * is not that location.
 */
export function ProductTable({
  products,
  hereLocationId,
  selectedLocation,
  ...actions
}: ProductTableProps) {
  const showHere = selectedLocation !== null && hereLocationId === selectedLocation.id;

  return (
    <table className="hidden lg:table w-full text-sm">
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Stock</TableHead>
          {showHere && <TableHead className="text-right">Here ({selectedLocation.name})</TableHead>}
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="text-right">Retail</TableHead>
          <th className="w-12"><span className="sr-only">Actions</span></th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((product) => (
          <ProductTableRow
            key={product.id}
            product={product}
            showHere={showHere}
            hereLocationId={hereLocationId}
            selectedLocationId={selectedLocation?.id ?? null}
            {...actions}
          />
        ))}
      </TableBody>
    </table>
  );
}

/** One table row; it owns its product's menu state (A2). */
function ProductTableRow({
  product,
  showHere,
  hereLocationId,
  selectedLocationId,
  isAdmin,
  onAdjust,
  onStockIn,
  onEdit,
  onDelete,
}: ProductActions & {
  product: ProductWithQuantity;
  showHere: boolean;
  hereLocationId: number | null | undefined;
  selectedLocationId: number | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isPending = product.approvalStatus === "PENDING_REVIEW";

  return (
    <TableRow className="h-12">
      <TableCell>
        <div className="font-semibold">{product.baseName}</div>
        {(product.variant || isPending) && (
          <div className="flex items-center gap-2">
            {product.variant && <span className="text-xs text-muted-foreground">{product.variant}</span>}
            {isPending && <StatusBadge tone="info">Pending review</StatusBadge>}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right">
        <ProductStock
          product={product}
          hereLocationId={hereLocationId}
          selectedLocationId={selectedLocationId}
          showHere={false}
          className="items-end"
        />
      </TableCell>
      {showHere && (
        <TableCell className="text-right tabular-nums">
          {product.hereQuantity === null ? "No record" : product.hereQuantity}
        </TableCell>
      )}
      <TableCell className="text-right tabular-nums">
        <Price value={product.costPrice} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <Price value={product.retailPrice} />
      </TableCell>
      <TableCell className="text-right">
        <ProductActionsMenu
          product={product}
          isAdmin={isAdmin}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onAdjust={onAdjust}
          onStockIn={onStockIn}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </TableCell>
    </TableRow>
  );
}
