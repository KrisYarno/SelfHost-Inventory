"use client";

import { useEffect, useState } from "react";
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
import {
  useDiscardStagingItem,
  useLocations,
  useStagingItems,
} from "@/hooks/use-staging";

const STATUS_TABS: { value: StagingStatus; label: string }[] = [
  { value: "RECEIVED", label: "Received" },
  { value: "GRADUATED", label: "Graduated" },
  { value: "DISCARDED", label: "Discarded" },
];

export default function PreStagingPage() {
  const router = useRouter();

  const [status, setStatus] = useState<StagingStatus>("RECEIVED");

  const {
    data: items = [],
    isFetching: loading,
    isError,
    error,
  } = useStagingItems(status);
  const { data: locations = [] } = useLocations();
  const discardMutation = useDiscardStagingItem();
  const pendingId = discardMutation.isPending
    ? discardMutation.variables ?? null
    : null;

  const [createOpen, setCreateOpen] = useState(false);
  const [graduateOpen, setGraduateOpen] = useState(false);
  const [graduateItem, setGraduateItem] = useState<GraduateStagingItem | null>(
    null
  );

  // Preserve the pre-migration 401 -> sign-in redirect; toast other failures.
  useEffect(() => {
    if (!isError) return;
    if ((error as { status?: number } | null)?.status === 401) {
      router.push("/auth/signin");
      return;
    }
    console.error("Error fetching staging items:", error);
    toast.error("Failed to load items");
  }, [isError, error, router]);

  const handleGraduate = (item: StagingItem) => {
    setGraduateItem({
      id: item.id,
      description: item.description,
      expectedQuantity: item.expectedQuantity,
      // W1-3a: the dialog books THIS, read-only. It used to derive its quantity
      // from expectedQuantity, which is how a counted 46 became a booked 50.
      countedQuantity: item.countedQuantity,
      // W1-3b: the receipt line's cost pre-fills the New-product cost field.
      unitCostCents: item.unitCostCents ?? null,
      locationId: item.locationId,
    });
    setGraduateOpen(true);
  };

  const handleDiscard = (item: StagingItem) => {
    if (
      !confirm(
        `Discard "${item.description}"? This marks the box as discarded and removes it from the active queue.`
      )
    ) {
      return;
    }
    discardMutation.mutate(item.id, {
      onSuccess: () => toast.success("Item discarded"),
      onError: (err) => {
        console.error("Error discarding staging item:", err);
        toast.error(
          err instanceof Error ? err.message : "Failed to discard item"
        );
      },
    });
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

      {/* Dialogs. The create/graduate mutations invalidate the staging queue
          (and, for graduation, the product/inventory caches), so the list
          refreshes without an explicit onSuccess refetch. */}
      <CreateStagingDialog open={createOpen} onOpenChange={setCreateOpen} />
      <GraduateDialog
        open={graduateOpen}
        onOpenChange={setGraduateOpen}
        item={graduateItem}
        locations={locations}
      />
    </div>
  );
}
