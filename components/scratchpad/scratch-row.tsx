"use client";

import { useState } from "react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { toast } from "sonner";

export type Row = {
  id: number;
  label: string;
  value: string | null;
  note: string | null;
  version: number;
  updatedByUser?: { username: string } | null;
};

type Field = "label" | "value" | "note";

export default function ScratchRow({
  row,
  labels,
  onChanged,
  onActivity,
}: {
  row: Row;
  labels?: string[];
  onChanged: () => void;
  onActivity: (active: boolean) => void;
}) {
  const { token } = useCSRF();
  const [editing, setEditing] = useState<null | Field>(null);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState(false);

  const begin = (field: Field) => {
    onActivity(true);
    setConflict(false);
    setEditing(field);
    setDraft(
      (field === "label" ? row.label : field === "value" ? row.value : row.note) ?? "",
    );
  };
  const cancel = () => {
    setEditing(null);
    onActivity(false);
  };

  const save = async () => {
    if (!editing) return;
    // empty value/note -> null (clear, .nullish); empty label is invalid (schema rejects)
    const next = draft === "" && editing !== "label" ? null : draft;
    const res = await fetch(`/api/scratchpad/${row.id}`, {
      method: "PATCH",
      headers: withCSRFHeaders({ "Content-Type": "application/json" }, token),
      body: JSON.stringify({ expectedVersion: row.version, [editing]: next }),
    });
    if (res.status === 409) {
      // E3: someone else changed it — refetch so the user sees the current value.
      setConflict(true);
      onChanged();
      return;
    }
    if (!res.ok) {
      toast.error("Could not save");
      return;
    }
    setEditing(null);
    onActivity(false);
    onChanged();
  };

  const remove = async () => {
    const res = await fetch(`/api/scratchpad/${row.id}`, {
      method: "DELETE",
      headers: withCSRFHeaders({ "Content-Type": "application/json" }, token),
      body: JSON.stringify({ expectedVersion: row.version }),
    });
    if (res.status === 409) {
      setConflict(true);
      onChanged();
      return;
    }
    if (res.ok) {
      onChanged();
    } else {
      toast.error("Could not delete");
    }
  };

  return (
    <div className="flex flex-col gap-0.5 py-1 border-b border-border/40 last:border-b-0">
      <div className="flex items-center gap-2">
        {editing === "label" ? (
          <>
            <input
              list={`scratch-labels-${row.id}`}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              className="border rounded px-1 text-sm"
            />
            <datalist id={`scratch-labels-${row.id}`}>
              {(labels ?? []).map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </>
        ) : (
          <button className="font-medium text-sm" onClick={() => begin("label")}>
            {row.label}
          </button>
        )}
        {editing === "value" ? (
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            className="border rounded px-1 text-sm w-28"
            placeholder="40 / TBD / 40-50"
          />
        ) : (
          <button
            className="text-sm text-muted-foreground"
            onClick={() => begin("value")}
          >
            {row.value ?? "—"}
          </button>
        )}
        {editing ? (
          <>
            <button className="text-xs text-blue-600 ml-auto" onClick={save}>
              Save
            </button>
            <button className="text-xs" onClick={cancel}>
              Cancel
            </button>
          </>
        ) : (
          <button className="text-xs text-red-500 ml-auto" onClick={remove}>
            Delete
          </button>
        )}
      </div>

      {editing === "note" ? (
        <input
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          className="border rounded px-1 text-sm w-full"
          placeholder="optional note"
        />
      ) : (
        <button
          className="text-xs text-muted-foreground text-left"
          onClick={() => begin("note")}
        >
          {row.note ?? "+ add note"}
        </button>
      )}

      {conflict && (
        <p className="text-xs text-amber-600">
          Someone else just changed this — refreshed to their value. Re-apply your edit if you still want it.
        </p>
      )}
      {row.updatedByUser && (
        <p className="text-[11px] text-muted-foreground">
          edited by {row.updatedByUser.username}
        </p>
      )}
    </div>
  );
}
