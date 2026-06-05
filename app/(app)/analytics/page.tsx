"use client";

import { AnalyticsHub } from "@/components/analytics/analytics-hub";
import { PageHeader } from "@/components/layout/page-header";

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Analytics" />
      <main className="flex-1 overflow-auto p-[var(--card-padding)]">
        <div className="mx-auto max-w-7xl">
          <AnalyticsHub />
        </div>
      </main>
    </div>
  );
}
