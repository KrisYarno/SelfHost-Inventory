"use client";

import { useState } from "react";
import { X, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface ModelChipEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  knownModels: string[];
  disabled?: boolean;
  idPrefix?: string;
}

/**
 * Chip/tag input for a provider's enabled models (D-B8): type + Enter to add,
 * 44px remove targets, inline duplicate rejection, seeded from a small per-kind
 * known-models constant. The ">=1 model when enabling" rule is enforced by the
 * owning panel, not here.
 */
export function ModelChipEditor({
  value,
  onChange,
  knownModels,
  disabled,
  idPrefix = "model",
}: ModelChipEditorProps) {
  const [input, setInput] = useState("");
  const [dupWarning, setDupWarning] = useState<string | null>(null);

  const add = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    if (value.includes(name)) {
      setDupWarning(`"${name}" is already added`);
      return;
    }
    setDupWarning(null);
    onChange([...value, name]);
    setInput("");
  };

  const remove = (name: string) => {
    onChange(value.filter((m) => m !== name));
  };

  const suggestions = knownModels.filter((m) => !value.includes(m));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Enabled models">
          {value.map((model) => (
            <li
              key={model}
              className="flex items-center gap-1 rounded-full border border-border bg-muted pl-3 pr-1 text-sm text-foreground"
            >
              <span className="font-mono">{model}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(model)}
                aria-label={`Remove ${model}`}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Input
          id={`${idPrefix}-input`}
          value={input}
          disabled={disabled}
          placeholder="Add a model id, then press Enter"
          aria-label="Add a model"
          onChange={(e) => {
            setInput(e.target.value);
            if (dupWarning) setDupWarning(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(input);
            }
          }}
        />
        <button
          type="button"
          disabled={disabled || !input.trim()}
          onClick={() => add(input)}
          aria-label="Add model"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {dupWarning && (
        <p className="text-body-sm text-warning-foreground" role="status">
          {dupWarning}
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-sm text-muted-foreground">Suggested:</span>
          {suggestions.map((model) => (
            <button
              key={model}
              type="button"
              disabled={disabled}
              onClick={() => add(model)}
              className={cn(
                "rounded-full border border-dashed border-border px-3 py-1 font-mono text-body-sm text-muted-foreground",
                "hover:border-solid hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              )}
            >
              + {model}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
