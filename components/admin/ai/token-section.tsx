"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TokenSecretDialog } from "@/components/admin/ai/token-secret-dialog";
import {
  useApiTokens,
  useCreateToken,
  useRevokeToken,
  type TokenView,
} from "@/hooks/use-ai-admin";

export const TOKENS_EMPTY_COPY =
  "No API tokens yet. Create one to connect an approved internal client.";
export const OWNER_ACCESS_CAPTION = "The token can read the companies this owner can access";

function fmtDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function RevokeButton({ token, onRevoke }: { token: TokenView; onRevoke: (id: string) => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive">
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke token {token.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The client using this token will lose access immediately. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep token</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            onClick={() => onRevoke(token.id)}
          >
            Revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function TokenSection() {
  const { data, isLoading } = useApiTokens();
  const { data: session } = useSession();
  const createToken = useCreateToken();
  const revokeToken = useRevokeToken();

  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState<string>("");
  const [secret, setSecret] = useState<string | null>(null);
  const [secretName, setSecretName] = useState<string | undefined>(undefined);

  const owners = data?.owners ?? [];

  // Preselect the current admin when present among eligible owners.
  const currentEmail = (session?.user as { email?: string } | undefined)?.email;
  const preselectId = useMemo(() => {
    if (ownerId) return ownerId;
    const me = owners.find((o) => o.email === currentEmail);
    return me ? String(me.id) : owners[0] ? String(owners[0].id) : "";
  }, [ownerId, owners, currentEmail]);

  const tokens = data?.tokens ?? [];
  const active = tokens.filter((t) => t.status === "active");
  const revoked = tokens.filter((t) => t.status === "revoked");
  const ordered = [...active, ...revoked];

  const handleCreate = async () => {
    if (!name.trim() || !preselectId) return;
    try {
      const created = await createToken.mutateAsync({
        name: name.trim(),
        ownerUserId: Number(preselectId),
      });
      setSecret(created.token);
      setSecretName(created.name);
      setName("");
      setOwnerId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create token");
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeToken.mutateAsync(id);
      toast.success("Token revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not revoke token");
    }
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h3 className="text-h4">API tokens</h3>
        <p className="text-body-sm text-muted-foreground">
          Read-only tokens for approved internal clients (the MCP sidecar).
        </p>
      </div>

      {/* Inline create form */}
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="token-name">Name</Label>
          <Input
            id="token-name"
            value={name}
            placeholder="e.g. Claude Desktop"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="token-owner">Owner</Label>
          <Select value={preselectId || undefined} onValueChange={setOwnerId}>
            <SelectTrigger id="token-owner">
              <SelectValue placeholder="Select an owner" />
            </SelectTrigger>
            <SelectContent>
              {owners.map((o) => (
                <SelectItem key={o.id} value={String(o.id)}>
                  {o.username} ({o.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-body-sm text-muted-foreground">{OWNER_ACCESS_CAPTION}</p>
        </div>
        <div className="space-y-2">
          <span className="block text-body-sm text-muted-foreground">Tier: Read only</span>
          <Button
            type="button"
            onClick={handleCreate}
            disabled={!name.trim() || !preselectId || createToken.isPending}
          >
            {createToken.isPending ? "Creating…" : "Create token"}
          </Button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : tokens.length === 0 ? (
        <p className="text-body text-muted-foreground">{TOKENS_EMPTY_COPY}</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Owner</th>
                  <th className="py-2 pr-4 font-medium">Access</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 font-medium">Last used</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((t) => (
                  <tr
                    key={t.id}
                    className={cn("border-b border-border", t.status === "revoked" && "opacity-60")}
                  >
                    <td className="py-2 pr-4 font-medium text-foreground">{t.name}</td>
                    <td className="py-2 pr-4">{t.owner.username}</td>
                    <td className="py-2 pr-4">{t.access}</td>
                    <td className="py-2 pr-4">{fmtDate(t.createdAt)}</td>
                    <td className="py-2 pr-4">{fmtDate(t.lastUsedAt)}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge tone={t.status === "active" ? "positive" : "neutral"}>
                        {t.status === "active" ? "Active" : "Revoked"}
                      </StatusBadge>
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {t.status === "active" && (
                        <RevokeButton token={t} onRevoke={handleRevoke} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile compact list rows */}
          <ul className="space-y-3 md:hidden">
            {ordered.map((t) => (
              <li
                key={t.id}
                className={cn(
                  "rounded-lg border border-border p-3",
                  t.status === "revoked" && "opacity-60",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{t.name}</span>
                  <StatusBadge tone={t.status === "active" ? "positive" : "neutral"}>
                    {t.status === "active" ? "Active" : "Revoked"}
                  </StatusBadge>
                </div>
                <p className="mt-1 text-body-sm text-muted-foreground">
                  {t.owner.username} · {t.access}
                </p>
                <p className="text-body-sm text-muted-foreground">
                  Created {fmtDate(t.createdAt)} · Last used {fmtDate(t.lastUsedAt)}
                </p>
                {t.status === "active" && (
                  <div className="mt-2">
                    <RevokeButton token={t} onRevoke={handleRevoke} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <TokenSecretDialog token={secret} tokenName={secretName} onClose={() => setSecret(null)} />
    </div>
  );
}
