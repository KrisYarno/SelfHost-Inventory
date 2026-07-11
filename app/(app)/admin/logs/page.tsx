// Top-level directive
"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChangeLogTab } from "@/components/logs/change-log-tab";
import { AuditLogTab } from "@/components/logs/audit-log-tab";
import { TransferLogTab } from "@/components/logs/transfer-log-tab";

type TabKey = "change" | "audit" | "transfers";

export default function AdminLogsHubPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = (searchParams?.get("tab") as TabKey) || "change";
  const [tab, setTab] = useState<TabKey>(initialTab);

  useEffect(() => {
    router.replace(`/admin/logs?tab=${tab}`);
  }, [tab, router]);

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 overflow-x-hidden">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Logs</h1>
        <p className="text-muted-foreground">
          Review inventory changes, transfers, and admin activity from one place.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="flex flex-wrap gap-2">
          <TabsTrigger value="change">Change Logs</TabsTrigger>
          <TabsTrigger value="audit">Audit Logs</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
        </TabsList>

        <TabsContent value="change" className="space-y-6">
          <ChangeLogTab active={tab === "change"} />
        </TabsContent>

        <TabsContent value="audit" className="space-y-6">
          <AuditLogTab active={tab === "audit"} />
        </TabsContent>

        <TabsContent value="transfers" className="space-y-6">
          <TransferLogTab active={tab === "transfers"} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
