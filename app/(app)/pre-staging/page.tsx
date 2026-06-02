"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PackageOpen, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import {
  StagingQueue,
  type StagingItem,
  type StagingStatus,
} from "@/components/staging/staging-queue";
import { CreateStagingDialog } from "@/components/staging/create-staging-dialog";
import {
  GraduateDialog,
  type GraduateStagingItem,
} from "@/components/staging/graduate-dialog";

interface Location {
  id: number;
  name: string;
}

const STATUS_TABS: { value: StagingStatus; label: string }[] = [
  { value: "RECEIVED", label: "Received" },
  { value: "GRADUATED", label: "Graduated" },
  { value: "DISCARDED", label: "Discarded" },
];

export default function PreStagingPage() {
  const router = useRouter();
  const { token: csrfToken } = useCSRF();

  const [status, setStatus] = useState<StagingStatus>("RECEIVED");
  const [items, setItems] = useState<StagingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState<Location[]>([]);
  const [pendingId, setPendingId] = useState<number | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [graduateOpen, setGraduateOpen] = useState(false);
  const [graduateItem, setGraduateItem] = useState<GraduateStagingItem | null>(
    null
  );

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/staging-items?status=${status}`);
      if (!response.ok) {
        if (response.status === 401) {
          router.push("/auth/signin");
          return;
        }
        throw new Error("Failed to fetch staging items");
      }
      const data = await response.json();
      setItems(data.items ?? []);
    } catch (error) {
      console.error("Error fetching staging items:", error);
      toast.error("Failed to load items");
    } finally {
      setLoading(false);
    }
  }, [status, router]);

  const fetchLocations = useCallback(async () => {
    try {
      const response = await fetch("/api/locations");
      if (!response.ok) return;
      const data = await response.json();
      // /api/locations returns a bare array; tolerate { locations } too.
      setLocations(data?.locations ?? data ?? []);
    } catch (error) {
      console.error("Error fetching locations:", error);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    fetchLocations();
  }, [fetchLocations]);

  const handleGraduate = (item: StagingItem) => {
    setGraduateItem({
      id: item.id,
      description: item.description,
      expectedQuantity: item.expectedQuantity,
      locationId: item.locationId,
    });
    setGraduateOpen(true);
  };

  const handleDiscard = async (item: StagingItem) => {
    if (
      !confirm(
        `Discard "${item.description}"? This marks the box as discarded and removes it from the active queue.`
      )
    ) {
      return;
    }
    setPendingId(item.id);
    try {
      const response = await fetch(
        `/api/staging-items/${item.id}/discard`,
        {
          method: "POST",
          headers: withCSRFHeaders({}, csrfToken),
        }
      );
      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        throw new Error(json.error || "Failed to discard item");
      }
      toast.success("Item discarded");
      await fetchItems();
    } catch (error) {
      console.error("Error discarding staging item:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to discard item"
      );
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div>
            <h1 className="flex items-center gap-2 text-3xl font-bold">
              <PackageOpen className="h-7 w-7" />
              Pre-Staging
            </h1>
            <p className="text-sm text-muted-foreground">
              Log, count, and graduate unlabeled boxes into real inventory.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Log new item
          </Button>
        </div>

        {/* Queue */}
        <Card>
          <CardHeader>
            <CardTitle>Intake Queue</CardTitle>
            <div className="flex gap-2 flex-wrap mt-4">
              {STATUS_TABS.map((tab) => (
                <Button
                  key={tab.value}
                  onClick={() => setStatus(tab.value)}
                  variant={status === tab.value ? "default" : "outline"}
                  size="sm"
                >
                  {tab.label}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <StagingQueue
              items={items}
              loading={loading}
              onGraduate={handleGraduate}
              onDiscard={handleDiscard}
              pendingId={pendingId}
            />
          </CardContent>
        </Card>
      </div>

      {/* Dialogs */}
      <CreateStagingDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={fetchItems}
      />
      <GraduateDialog
        open={graduateOpen}
        onOpenChange={setGraduateOpen}
        item={graduateItem}
        locations={locations}
        onSuccess={fetchItems}
      />
    </div>
  );
}
