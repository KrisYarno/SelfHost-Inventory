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

interface Integration {
  id: string;
  name: string;
  platform: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrations: Integration[];
}

export function BulkMapChooserDialog({ open, onOpenChange, integrations }: Props) {
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pick a store to bulk map</DialogTitle>
          <DialogDescription>
            Choose which integration&apos;s catalog you want to map.
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
                router.push(`/admin/product-mappings/${i.id}/map`);
              }}
            >
              <span className="font-medium">{i.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {i.platform}
              </span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
