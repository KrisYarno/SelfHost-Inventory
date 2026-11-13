"use client";

import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PlatformBadge } from "@/components/orders/platform-badge";
import type { PlatformType } from "@/types/external-orders";

interface Integration {
  id: string;
  name: string;
  platform: PlatformType;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrations: Integration[];
  /** Replaces the bulk-map title (Add Mapping asks which store a product is from). */
  title?: string;
  /** Replaces the bulk-map description. */
  description?: string;
  /**
   * When given, picking a store calls this with its integration id instead of
   * opening that store's bulk-map page (§ P2-B3-1R, MS-3-16).
   */
  onChoose?: (integrationId: string) => void;
}

export function BulkMapChooserDialog({
  open,
  onOpenChange,
  integrations,
  title,
  description,
  onChoose,
}: Props) {
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? "Pick a store to bulk map"}</DialogTitle>
          <DialogDescription>
            {description ?? <>Choose which integration&apos;s catalog you want to map.</>}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {integrations.map((i) => (
            <Button
              key={i.id}
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                onOpenChange(false);
                if (onChoose) {
                  onChoose(i.id);
                } else {
                  router.push(`/admin/product-mappings/${i.id}/map`);
                }
              }}
            >
              <span className="font-medium">{i.name}</span>
              <PlatformBadge platform={i.platform} size="sm" className="ml-2" />
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
