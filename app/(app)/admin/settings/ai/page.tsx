"use client";

import Link from "next/link";
import { ArrowLeft, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ProviderPanel } from "@/components/admin/ai/provider-panel";
import { RoutingDefaults } from "@/components/admin/ai/routing-defaults";
import { TokenSection } from "@/components/admin/ai/token-section";
import {
  useAiProviders,
  useAiRouting,
  PROVIDER_KINDS,
  PROVIDER_LABELS,
  type ProviderKind,
} from "@/hooks/use-ai-admin";

export default function AiSettingsPage() {
  const providersQuery = useAiProviders();
  const routingQuery = useAiRouting();

  const providers = providersQuery.data ?? [];
  const routing = routingQuery.data ?? { config: null, resolved: null };

  const routedKinds = new Set<ProviderKind>();
  if (routing.config) {
    routedKinds.add(routing.config.default.providerKind);
    if (routing.config.surfaces?.assistant) {
      routedKinds.add(routing.config.surfaces.assistant.providerKind);
    }
  }

  return (
    <div className="container mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Link
          href="/admin/settings"
          className="inline-flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> System Settings
        </Link>
        <div className="flex items-center gap-2">
          <Sparkles className="h-7 w-7" />
          <h1 className="text-display">AI providers</h1>
        </div>
        <p className="text-body text-muted-foreground">
          Configure AI providers, the Assistant routing default, and read-only API tokens.
        </p>
      </div>

      {/* Providers — flat config panels (bg-surface + divide-y, no Card shadows) */}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {providersQuery.isLoading ? (
          PROVIDER_KINDS.map((kind) => (
            <div key={kind} className="space-y-3 p-4 sm:p-6">
              <div className="flex items-center justify-between">
                <span className="text-h4">{PROVIDER_LABELS[kind]}</span>
                <Skeleton className="h-6 w-24" />
              </div>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ))
        ) : providersQuery.isError ? (
          <div className="p-4 sm:p-6">
            <div className="rounded-md border border-negative-border bg-negative-muted p-4">
              <p className="text-body text-negative-foreground">Could not load AI providers.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => providersQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : (
          providers.map((provider) => (
            <ProviderPanel
              key={provider.kind}
              provider={provider}
              isRouted={routedKinds.has(provider.kind)}
            />
          ))
        )}
      </div>

      {/* Disable-only affordance caption (D-B8, verbatim) */}
      <p className="text-body-sm text-muted-foreground">
        Providers can be disabled but not removed, so past activity stays attributable.
      </p>

      {/* Routing defaults — flat surface */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {routingQuery.isLoading ? (
          <div className="space-y-3 p-4 sm:p-6">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <RoutingDefaults providers={providers} routing={routing} />
        )}
      </div>

      {/* API tokens — flat surface */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <TokenSection />
      </div>
    </div>
  );
}
