"use client";

/**
 * Global reorder settings admin section (Lane reorder-points, Task 4).
 *
 * Edits the shop-wide reorder defaults a product inherits when it has no per-product
 * override. Self-contained (its own GET/PUT against /api/admin/reorder-settings) so it
 * drops into the settings page with a single import.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { PackageCheck } from "lucide-react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

interface ReorderSettings {
  defaultLeadTimeDays: number;
  defaultSafetyStockDays: number;
  defaultTargetCoverageMultiple: number;
  minEvidenceEvents: number;
}

const FIELDS: { key: keyof ReorderSettings; label: string; min: number; help: string }[] = [
  { key: "defaultLeadTimeDays", label: "Default lead time (days)", min: 1, help: "Days from order to arrival. Always positive." },
  { key: "defaultSafetyStockDays", label: "Default buffer (days)", min: 0, help: "Flat policy buffer. 0 = no buffer." },
  { key: "defaultTargetCoverageMultiple", label: "Order-up-to multiple", min: 1, help: "Target level = this × lead-time demand." },
  { key: "minEvidenceEvents", label: "Min evidence events", min: 0, help: "Outbound events required before a suggestion is made." },
];

export function ReorderSettingsSection() {
  const { token: csrfToken } = useCSRF();
  const [settings, setSettings] = useState<ReorderSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/reorder-settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load reorder settings"))))
      .then((data) => {
        if (active) setSettings(data);
      })
      .catch(() => toast.error("Failed to load reorder settings"))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = (key: keyof ReorderSettings, value: string) => {
    const parsed = parseInt(value, 10);
    setSettings((prev) => (prev ? { ...prev, [key]: Number.isNaN(parsed) ? 0 : parsed } : prev));
  };

  const handleSave = async () => {
    if (!settings) return;
    try {
      setSaving(true);
      const res = await fetch("/api/admin/reorder-settings", {
        method: "PUT",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save reorder settings");
      }
      setSettings(await res.json());
      toast.success("Reorder settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save reorder settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageCheck className="h-5 w-5" />
          Reorder defaults
        </CardTitle>
        <CardDescription>
          Shop-wide defaults a product inherits when it has no per-product override.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading || !settings ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.key} className="space-y-2">
                  <Label htmlFor={f.key}>{f.label}</Label>
                  <Input
                    id={f.key}
                    type="number"
                    min={f.min}
                    step="1"
                    value={settings[f.key]}
                    onChange={(e) => update(f.key, e.target.value)}
                    disabled={saving}
                  />
                  <p className="text-xs text-muted-foreground">{f.help}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving || !csrfToken}>
                {saving ? "Saving…" : "Save reorder defaults"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
