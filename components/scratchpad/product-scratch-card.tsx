"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import ScratchRow, { type Row } from "./scratch-row";

interface ScratchProductCard {
  id: number;
  name: string;
  baseName?: string | null;
  variant?: string | null;
  scratchpadPrices: Row[];
}

export default function ProductScratchCard({
  product,
  labels,
  onActivity,
  onChanged,
}: {
  product: ScratchProductCard;
  labels?: string[];
  onActivity: (active: boolean) => void;
  onChanged: () => void;
}) {
  const { token } = useCSRF();
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);

  const openAdd = () => {
    onActivity(true);
    setNewLabel("");
    setNewValue("");
    setAdding(true);
  };
  const closeAdd = () => {
    setAdding(false);
    onActivity(false);
  };

  const saveNew = async () => {
    const label = newLabel.trim();
    if (!label) {
      toast.error("Label is required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/scratchpad", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, token),
        body: JSON.stringify({
          productId: product.id,
          label,
          value: newValue.trim() === "" ? null : newValue.trim(),
        }),
      });
      if (!res.ok) {
        toast.error("Could not add row");
        return;
      }
      closeAdd();
      onChanged();
    } catch {
      toast.error("Could not add row");
    } finally {
      setSaving(false);
    }
  };

  const rows = product.scratchpadPrices ?? [];

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">{product.name}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 space-y-1">
        {rows.length === 0 && !adding && (
          <p className="text-xs text-muted-foreground py-1">No prices yet.</p>
        )}
        {rows.map((row) => (
          <ScratchRow
            key={row.id}
            row={row}
            labels={labels}
            onActivity={onActivity}
            onChanged={onChanged}
          />
        ))}

        {adding ? (
          <div className="flex flex-col gap-2 pt-2">
            <input
              list={`scratch-labels-new-${product.id}`}
              value={newLabel}
              autoFocus
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label (e.g. Awake Price)"
              className="border rounded px-2 py-1 text-sm"
            />
            <datalist id={`scratch-labels-new-${product.id}`}>
              {(labels ?? []).map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="Value (40 / TBD / 40-50)"
              className="border rounded px-2 py-1 text-sm"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveNew} disabled={saving}>
                {saving ? "Adding…" : "Add"}
              </Button>
              <Button size="sm" variant="ghost" onClick={closeAdd} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={openAdd}
            className="mt-1 flex items-center gap-1 text-xs text-blue-600 hover:underline"
          >
            <Plus className="h-3 w-3" /> add price
          </button>
        )}
      </CardContent>
    </Card>
  );
}
