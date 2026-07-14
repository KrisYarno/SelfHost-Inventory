"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PROVIDER_LABELS,
  useSaveRouting,
  type ProviderKind,
  type ProviderView,
  type RoutingView,
} from "@/hooks/use-ai-admin";

export const ROUTING_EMPTY_COPY =
  "Configure and enable a provider before choosing a default model.";

/** A provider is routable only when enabled, credentialed, and listing >=1 model. */
export function isSelectableProvider(p: ProviderView): boolean {
  const hasCredential = p.kind === "OLLAMA" ? !!p.baseUrl : p.hasKey;
  return p.isEnabled && hasCredential && p.enabledModels.length > 0;
}

interface RoutingDefaultsProps {
  providers: ProviderView[];
  routing: RoutingView;
}

export function RoutingDefaults({ providers, routing }: RoutingDefaultsProps) {
  const saveRouting = useSaveRouting();
  const selectable = providers.filter(isSelectableProvider);

  const initialKind = routing.config?.default.providerKind ?? selectable[0]?.kind ?? null;
  const initialModel = routing.config?.default.model ?? "";

  const [kind, setKind] = useState<ProviderKind | null>(initialKind);
  const [model, setModel] = useState<string>(initialModel);

  const modelOptions = useMemo(() => {
    const p = providers.find((x) => x.kind === kind);
    return p ? p.enabledModels : [];
  }, [providers, kind]);

  if (selectable.length === 0) {
    return (
      <div className="p-4 sm:p-6">
        <h3 className="text-h4">Routing defaults</h3>
        <p className="mt-2 text-body text-muted-foreground">{ROUTING_EMPTY_COPY}</p>
      </div>
    );
  }

  const modelValid = !!model && modelOptions.includes(model);
  const changed = kind !== routing.config?.default.providerKind || model !== routing.config?.default.model;

  const handleKindChange = (next: string) => {
    const nextKind = next as ProviderKind;
    setKind(nextKind);
    const p = providers.find((x) => x.kind === nextKind);
    const opts = p ? p.enabledModels : [];
    setModel(opts.includes(model) ? model : opts[0] ?? "");
  };

  const handleSave = async () => {
    if (!kind || !modelValid) return;
    try {
      await saveRouting.mutateAsync({ default: { providerKind: kind, model } });
      toast.success("Routing defaults saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save routing defaults");
    }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h3 className="text-h4">Routing defaults</h3>
        <p className="text-body-sm text-muted-foreground">
          The model the in-app Assistant uses.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="routing-provider">Provider</Label>
          <Select value={kind ?? ""} onValueChange={handleKindChange}>
            <SelectTrigger id="routing-provider">
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.kind} value={p.kind} disabled={!isSelectableProvider(p)}>
                  {PROVIDER_LABELS[p.kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="routing-model">Model</Label>
          {modelOptions.length === 0 ? (
            <p className="text-body-sm text-warning-foreground">Add at least one model</p>
          ) : (
            <Select value={model || ""} onValueChange={setModel}>
              <SelectTrigger id="routing-model">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <p className="text-body-sm text-muted-foreground">
        {routing.resolved
          ? `Assistant uses: ${PROVIDER_LABELS[routing.resolved.providerKind]} · ${routing.resolved.model}`
          : "Assistant has no resolved model yet."}
      </p>

      <Button
        type="button"
        onClick={handleSave}
        disabled={!modelValid || !changed || saveRouting.isPending}
      >
        {saveRouting.isPending ? "Saving…" : "Save routing"}
      </Button>
    </div>
  );
}
