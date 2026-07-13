"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderKind = "ANTHROPIC" | "OPENAI" | "GOOGLE" | "OLLAMA";

export const PROVIDER_KINDS: ProviderKind[] = ["ANTHROPIC", "OPENAI", "GOOGLE", "OLLAMA"];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  ANTHROPIC: "Anthropic",
  OPENAI: "OpenAI",
  GOOGLE: "Google",
  OLLAMA: "Ollama",
};

export interface ProviderView {
  kind: ProviderKind;
  isEnabled: boolean;
  hasKey: boolean;
  baseUrl: string | null;
  enabledModels: string[];
  exists: boolean;
  updatedAt: string | null;
}

export interface ProviderRef {
  providerKind: ProviderKind;
  model: string;
}

export interface RoutingConfig {
  default: ProviderRef;
  surfaces?: { assistant?: ProviderRef };
}

export interface RoutingView {
  config: RoutingConfig | null;
  resolved: ProviderRef | null;
}

export interface TokenOwner {
  id: number;
  username: string;
  email: string;
}

export interface TokenView {
  id: string;
  name: string;
  tier: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "revoked";
  owner: TokenOwner;
  access: string;
}

export interface TokensView {
  tokens: TokenView[];
  owners: TokenOwner[];
}

/** The plaintext secret, returned exactly once by the create endpoint. */
export interface CreatedToken {
  token: string;
  id: string;
  name: string;
  tier: string;
  createdAt: string;
  owner: TokenOwner;
}

export interface ProviderSavePayload {
  isEnabled?: boolean;
  enabledModels?: string[];
  baseUrl?: string;
  apiKey?: string;
  removeKey?: boolean;
}

export interface FetchError extends Error {
  status?: number;
}

async function getJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`) as FetchError;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useAiProviders() {
  return useQuery<ProviderView[], FetchError>({
    queryKey: ["ai-providers"],
    queryFn: async () => {
      const data = await getJSON("/api/admin/ai-providers");
      return (data.providers ?? []) as ProviderView[];
    },
  });
}

export function useAiRouting() {
  return useQuery<RoutingView, FetchError>({
    queryKey: ["ai-routing"],
    queryFn: async () => {
      const data = await getJSON("/api/admin/ai-providers/routing");
      return { config: data.config ?? null, resolved: data.resolved ?? null } as RoutingView;
    },
  });
}

export function useApiTokens() {
  return useQuery<TokensView, FetchError>({
    queryKey: ["api-tokens"],
    queryFn: async () => {
      const data = await getJSON("/api/admin/api-tokens");
      return { tokens: data.tokens ?? [], owners: data.owners ?? [] } as TokensView;
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useSaveProvider() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async ({ kind, body }: { kind: ProviderKind; body: ProviderSavePayload }) => {
      const res = await fetch(`/api/admin/ai-providers/${kind}`, {
        method: "PUT",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Could not save provider settings");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      queryClient.invalidateQueries({ queryKey: ["ai-routing"] });
    },
  });
}

export function useTestProvider() {
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (kind: ProviderKind) => {
      const res = await fetch(`/api/admin/ai-providers/${kind}/test`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      return { ok: !!data.ok } as { ok: boolean };
    },
  });
}

export function useSaveRouting() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (config: RoutingConfig) => {
      const res = await fetch("/api/admin/ai-providers/routing", {
        method: "PUT",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Could not save routing defaults");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-routing"] });
    },
  });
}

export function useCreateToken() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async ({ name, ownerUserId }: { name: string; ownerUserId: number }) => {
      const res = await fetch("/api/admin/api-tokens", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ name, ownerUserId }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Could not create token");
      }
      return (await res.json()) as CreatedToken;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}

export function useRevokeToken() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/api-tokens/${id}/revoke`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Could not revoke token");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}
