"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import type { CatalogResponse, CatalogRow } from "@/types/bulk-map";
import { rowKey } from "@/types/bulk-map";

interface ConfirmArgs {
  integrationId: string;
  row: CatalogRow;
  internalProductId: number;
  internalProductName: string;
}

interface UndoArgs {
  integrationId: string;
  row: CatalogRow;
  linkId: string;
}

async function reconcileMappingsOnly(
  queryClient: ReturnType<typeof useQueryClient>,
  integrationId: string,
) {
  const res = await fetch(
    `/api/admin/product-mappings?integrationId=${integrationId}&pageSize=500`,
  );
  if (!res.ok) return;
  const data = (await res.json()) as {
    mappings: Array<{
      id: string;
      externalProductId: string;
      externalVariantId: string | null;
      internalProductId: number | null;
      isBundle?: boolean;
      internalProduct?: { name?: string };
      bundleComponents?: Array<{ internalProductId: number }>;
    }>;
  };
  const byKey = new Map<string, (typeof data.mappings)[number]>();
  for (const m of data.mappings) {
    byKey.set(`${m.externalProductId}::${m.externalVariantId ?? ""}`, m);
  }
  queryClient.setQueryData<CatalogResponse | undefined>(
    ["bulk-map-catalog", integrationId],
    (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        rows: prev.rows.map((r) => {
          const key = `${r.externalProductId}::${r.externalVariantId ?? ""}`;
          const hit = byKey.get(key);
          if (hit) {
            return {
              ...r,
              alreadyMapped: true,
              existingMapping: {
                linkId: hit.id,
                internalProductId: hit.internalProductId,
                internalProductName: hit.internalProduct?.name ?? "",
                isBundle: hit.isBundle,
                componentCount: hit.bundleComponents?.length,
              },
            };
          }
          if (r.alreadyMapped) {
            return { ...r, alreadyMapped: false, existingMapping: undefined };
          }
          return r;
        }),
      };
    },
  );
}

export function useRowActions() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();

  const patchRow = useCallback(
    (integrationId: string, row: CatalogRow, patch: Partial<CatalogRow>) => {
      queryClient.setQueryData<CatalogResponse | undefined>(
        ["bulk-map-catalog", integrationId],
        (prev) => {
          if (!prev) return prev;
          const key = rowKey(row);
          return {
            ...prev,
            rows: prev.rows.map((r) =>
              rowKey(r) === key ? { ...r, ...patch } : r,
            ),
          };
        },
      );
    },
    [queryClient],
  );

  const undo = useCallback(
    async ({ integrationId, row, linkId }: UndoArgs) => {
      if (!csrfToken) throw new Error("Missing CSRF token");

      // Capture prior mapping state so we can roll the row back on DELETE
      // failure — otherwise the UI shows the row as unmapped while the
      // server still has the mapping, which sets the user up for a 409 the
      // next time they try to map it.
      const cached = queryClient.getQueryData<CatalogResponse>([
        "bulk-map-catalog",
        integrationId,
      ]);
      const priorRow = cached?.rows.find((r) => rowKey(r) === rowKey(row));
      const priorMapping = priorRow?.existingMapping;

      patchRow(integrationId, row, { alreadyMapped: false, existingMapping: undefined });
      const res = await fetch(`/api/admin/product-mappings?linkId=${linkId}`, {
        method: "DELETE",
        headers: withCSRFHeaders({}, csrfToken),
      });
      if (!res.ok) {
        if (priorMapping) {
          patchRow(integrationId, row, {
            alreadyMapped: true,
            existingMapping: priorMapping,
          });
        }
        toast.error("Undo failed — the mapping is still active. Manage from the Mapped tab.");
      } else {
        toast.success("Mapping undone");
      }
    },
    [csrfToken, patchRow, queryClient],
  );

  const confirm = useCallback(
    async ({ integrationId, row, internalProductId, internalProductName }: ConfirmArgs) => {
      if (!csrfToken) throw new Error("Missing CSRF token");

      patchRow(integrationId, row, {
        alreadyMapped: true,
        existingMapping: {
          linkId: "__pending__",
          internalProductId,
          internalProductName,
        },
      });

      const res = await fetch(`/api/products/${internalProductId}/links`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          integrationId,
          externalProductId: row.externalProductId,
          externalVariantId: row.externalVariantId ?? undefined,
          externalSku: row.sku ?? undefined,
          externalTitle:
            row.variantTitle
              ? `${row.parentTitle} — ${row.variantTitle}`
              : row.parentTitle,
        }),
      });

      if (!res.ok) {
        patchRow(integrationId, row, { alreadyMapped: false, existingMapping: undefined });
        const body = await res.json().catch(() => ({}));
        const msg = body.error || `Save failed (${res.status})`;
        if (res.status === 409) {
          await reconcileMappingsOnly(queryClient, integrationId);
          throw new Error(
            "This external product is already mapped by another session — list refreshed.",
          );
        }
        throw new Error(msg);
      }

      const link = await res.json();
      patchRow(integrationId, row, {
        alreadyMapped: true,
        existingMapping: {
          linkId: link.id,
          internalProductId,
          internalProductName,
        },
      });

      toast.success(`Mapped ${row.parentTitle}${row.variantTitle ? ` / ${row.variantTitle}` : ""}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void undo({ integrationId, row, linkId: link.id });
          },
        },
        duration: 5000,
      });

      return link.id as string;
    },
    [csrfToken, patchRow, queryClient, undo],
  );

  const confirmBundle = useCallback(
    async ({
      integrationId,
      row,
      components,
    }: {
      integrationId: string;
      row: CatalogRow;
      components: Array<{ internalProductId: number; quantity: number }>;
    }) => {
      if (!csrfToken) throw new Error("Missing CSRF token");

      patchRow(integrationId, row, {
        alreadyMapped: true,
        existingMapping: {
          linkId: "__pending__",
          internalProductId: null,
          internalProductName: "",
          isBundle: true,
          componentCount: components.length,
        },
      });

      const res = await fetch(`/api/products/bundle-links`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          integrationId,
          externalProductId: row.externalProductId,
          externalVariantId: row.externalVariantId ?? undefined,
          externalSku: row.sku ?? undefined,
          externalTitle: row.variantTitle
            ? `${row.parentTitle} — ${row.variantTitle}`
            : row.parentTitle,
          components,
        }),
      });

      if (!res.ok) {
        patchRow(integrationId, row, { alreadyMapped: false, existingMapping: undefined });
        const body = await res.json().catch(() => ({}));
        const msg = body.error || `Save failed (${res.status})`;
        if (res.status === 409) {
          await reconcileMappingsOnly(queryClient, integrationId);
          throw new Error(
            "This external product is already mapped by another session — list refreshed.",
          );
        }
        throw new Error(msg);
      }

      const link = await res.json();
      patchRow(integrationId, row, {
        alreadyMapped: true,
        existingMapping: {
          linkId: link.id,
          internalProductId: null,
          internalProductName: "",
          isBundle: true,
          componentCount: components.length,
        },
      });

      toast.success(
        `Mapped ${row.parentTitle} as a bundle (${components.length} components)`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              void undo({ integrationId, row, linkId: link.id });
            },
          },
          duration: 5000,
        },
      );

      return link.id as string;
    },
    [csrfToken, patchRow, queryClient, undo],
  );

  const editBundle = useCallback(
    async ({
      linkId,
      components,
    }: {
      linkId: string;
      components: Array<{ internalProductId: number; quantity: number }>;
    }) => {
      if (!csrfToken) throw new Error("Missing CSRF token");

      const res = await fetch(`/api/products/bundle-links/${linkId}`, {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ components }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Update failed (${res.status})`);
      }

      toast.success(`Bundle updated (${components.length} components)`);
      return res.json();
    },
    [csrfToken],
  );

  return { confirm, undo, confirmBundle, editBundle };
}
