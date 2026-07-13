"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ModelChipEditor } from "@/components/admin/ai/model-chip-editor";
import {
  PROVIDER_LABELS,
  useSaveProvider,
  useTestProvider,
  type ProviderKind,
  type ProviderSavePayload,
  type ProviderView,
} from "@/hooks/use-ai-admin";

// Small per-kind seed lists (D-B8: chip editor seeded from a known-models
// constant). Fully editable by the admin — these are conveniences, not claims.
export const KNOWN_MODELS: Record<ProviderKind, string[]> = {
  ANTHROPIC: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  OPENAI: ["gpt-5.1", "gpt-5.1-mini", "o4-mini"],
  GOOGLE: ["gemini-2.5-pro", "gemini-2.5-flash"],
  OLLAMA: ["llama3.3", "qwen2.5", "mistral"],
};

// D-B8 / D-B7 VERBATIM copy.
export const ROUTED_DISABLE_MESSAGE =
  "Assistant uses this provider. Choose another model in Routing defaults before disabling it.";
export const OLLAMA_PROMPT_WARNING = "This endpoint will receive inventory data in prompts.";
export const OLLAMA_UNREACHABLE =
  "Ollama could not be reached. Check the endpoint and whether Ollama is running.";

export type ProviderStatusKey =
  | "needs-credential"
  | "needs-models"
  | "disabled"
  | "unverified"
  | "configured";

export interface ProviderStatus {
  key: ProviderStatusKey;
  label: string;
  tone: StatusTone;
}

/**
 * The single header status, by strict precedence (D-B8): Needs key/endpoint ->
 * Needs models -> Disabled -> Enabled, not yet verified -> Configured. Pure and
 * exported for the panel state-precedence test.
 */
export function computeProviderStatus(input: {
  kind: ProviderKind;
  hasCredential: boolean;
  modelCount: number;
  isEnabled: boolean;
  pendingVerify: boolean;
}): ProviderStatus {
  if (!input.hasCredential) {
    return {
      key: "needs-credential",
      tone: "warning",
      label: input.kind === "OLLAMA" ? "Needs endpoint" : "Needs key",
    };
  }
  if (input.modelCount === 0) {
    return { key: "needs-models", tone: "warning", label: "Needs models" };
  }
  if (!input.isEnabled) {
    return { key: "disabled", tone: "neutral", label: "Disabled" };
  }
  if (input.pendingVerify) {
    return { key: "unverified", tone: "info", label: "Enabled — not yet verified" };
  }
  return { key: "configured", tone: "positive", label: "Configured" };
}

interface Draft {
  isEnabled: boolean;
  enabledModels: string[];
  baseUrl: string;
}

type KeyMode = "keep" | "replace" | "remove";

function initDraft(provider: ProviderView): Draft {
  return {
    isEnabled: provider.isEnabled,
    enabledModels: [...provider.enabledModels],
    baseUrl: provider.baseUrl ?? "",
  };
}

interface ProviderPanelProps {
  provider: ProviderView;
  isRouted: boolean;
}

export function ProviderPanel({ provider, isRouted }: ProviderPanelProps) {
  const { kind } = provider;
  const isOllama = kind === "OLLAMA";
  const label = PROVIDER_LABELS[kind];

  const saveProvider = useSaveProvider();
  const testProvider = useTestProvider();

  const [draft, setDraft] = useState<Draft>(() => initDraft(provider));
  const [dirty, setDirty] = useState(false);
  const [keyMode, setKeyMode] = useState<KeyMode>("keep");
  const [keyInput, setKeyInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pendingVerify, setPendingVerify] = useState(false);
  const [testResult, setTestResult] = useState<"verified" | "failed" | null>(null);

  const sig = `${provider.isEnabled}|${provider.hasKey}|${provider.baseUrl ?? ""}|${provider.enabledModels.join(",")}`;
  // Sync a CLEAN panel to fresh server data; never clobber an in-progress draft.
  useEffect(() => {
    if (!dirty) {
      setDraft(initDraft(provider));
      setKeyMode("keep");
      setKeyInput("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const reset = () => {
    setDraft(initDraft(provider));
    setKeyMode("keep");
    setKeyInput("");
    setDirty(false);
    setSaveError(null);
    setInlineError(null);
  };

  const markDirty = () => {
    setDirty(true);
    setSaveError(null);
  };

  const hasCredential = isOllama
    ? draft.baseUrl.trim().length > 0
    : (provider.hasKey && keyMode !== "remove") || keyInput.trim().length > 0;

  const status = computeProviderStatus({
    kind,
    hasCredential,
    modelCount: draft.enabledModels.length,
    isEnabled: draft.isEnabled,
    pendingVerify,
  });

  const handleToggleEnabled = (next: boolean) => {
    if (!next && isRouted && provider.isEnabled) {
      setInlineError(ROUTED_DISABLE_MESSAGE);
      return;
    }
    setInlineError(null);
    setDraft((d) => ({ ...d, isEnabled: next }));
    markDirty();
  };

  const handleSave = async () => {
    const body: ProviderSavePayload = {
      isEnabled: draft.isEnabled,
      enabledModels: draft.enabledModels,
    };
    if (isOllama) {
      body.baseUrl = draft.baseUrl.trim();
    } else if (keyMode === "replace" && keyInput.trim()) {
      body.apiKey = keyInput.trim();
    } else if (keyMode === "remove") {
      body.removeKey = true;
    }

    try {
      await saveProvider.mutateAsync({ kind, body });
      toast.success(`${label} settings saved`);
      if (body.apiKey) setPendingVerify(true);
      setTestResult(null);
      setDirty(false);
      setKeyMode("keep");
      setKeyInput("");
      setSaveError(null);
      setInlineError(null);
    } catch (err) {
      // Draft is preserved (D-B8): show the in-row save failure copy VERBATIM.
      setSaveError(`Could not save ${label} settings. Your changes are still here.`);
    }
  };

  const handleTest = async () => {
    const { ok } = await testProvider.mutateAsync(kind);
    setTestResult(ok ? "verified" : "failed");
    if (ok) setPendingVerify(false);
  };

  return (
    <section className="p-4 sm:p-6" aria-label={`${label} provider`}>
      {/* Header row: kind + ONE status (>=14px) + enable Switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-h4">{label}</h3>
          <StatusBadge size="body" tone={status.tone}>
            {status.label}
          </StatusBadge>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`enable-${kind}`} className="text-body-sm text-muted-foreground">
            {draft.isEnabled ? "Enabled" : "Disabled"}
          </Label>
          <Switch
            id={`enable-${kind}`}
            checked={draft.isEnabled}
            onCheckedChange={handleToggleEnabled}
          />
        </div>
      </div>

      {inlineError && (
        <p className="mt-2 text-body-sm text-warning-foreground" role="alert">
          {inlineError}
        </p>
      )}

      <div className="mt-4 space-y-4">
        {/* Credential / endpoint */}
        {isOllama ? (
          <div className="space-y-2">
            <Label htmlFor={`baseurl-${kind}`}>Endpoint URL</Label>
            <Input
              id={`baseurl-${kind}`}
              value={draft.baseUrl}
              placeholder="http://localhost:11434"
              onChange={(e) => {
                setDraft((d) => ({ ...d, baseUrl: e.target.value }));
                markDirty();
              }}
            />
            <p className="text-body-sm text-warning-foreground">{OLLAMA_PROMPT_WARNING}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={`key-${kind}`}>API key</Label>
            {provider.hasKey && keyMode === "keep" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">Key set ••••</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setKeyMode("replace");
                    setKeyInput("");
                    markDirty();
                  }}
                >
                  Replace key
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                      Remove saved key
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove the saved {label} key?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The saved key will be cleared when you save changes. You can add a new
                        key later.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep key</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          setKeyMode("remove");
                          markDirty();
                        }}
                      >
                        Remove key
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : keyMode === "remove" ? (
              <div className="flex items-center gap-2">
                <span className="text-body-sm text-warning-foreground">
                  Key will be removed when you save.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setKeyMode("keep");
                  }}
                >
                  Undo
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                {/* Replace reveals an EMPTY input — nothing to reveal, no Eye toggle. */}
                <Input
                  id={`key-${kind}`}
                  type="password"
                  value={keyInput}
                  autoComplete="off"
                  placeholder="Paste a new API key"
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    markDirty();
                  }}
                />
                {provider.hasKey && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setKeyMode("keep");
                      setKeyInput("");
                    }}
                  >
                    Keep current
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Model editor */}
        <div className="space-y-2">
          <Label>Enabled models</Label>
          <ModelChipEditor
            value={draft.enabledModels}
            knownModels={KNOWN_MODELS[kind]}
            idPrefix={`models-${kind}`}
            onChange={(next) => {
              setDraft((d) => ({ ...d, enabledModels: next }));
              markDirty();
            }}
          />
        </div>

        {/* Test + result */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testProvider.isPending}
          >
            {testProvider.isPending ? "Testing…" : "Test connection"}
          </Button>
          {testResult === "verified" && (
            <StatusBadge tone="positive" size="body">
              Verified
            </StatusBadge>
          )}
          {testResult === "failed" && (
            <span className="text-body-sm text-negative-foreground" role="status">
              {isOllama ? OLLAMA_UNREACHABLE : `Could not verify ${label}. Check the key.`}
            </span>
          )}
        </div>

        {saveError && (
          <p className="text-body-sm text-negative-foreground" role="alert">
            {saveError}
          </p>
        )}

        {/* Draft controls */}
        <div className="flex items-center gap-2">
          <Button type="button" onClick={handleSave} disabled={!dirty || saveProvider.isPending}>
            {saveProvider.isPending ? "Saving…" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={reset}
            disabled={!dirty || saveProvider.isPending}
          >
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}
