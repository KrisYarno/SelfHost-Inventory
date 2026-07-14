"use client";

import { AnalyticsHub } from "@/components/analytics/analytics-hub";
import { PageHeader } from "@/components/layout/page-header";

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Analytics" />
      {/* A section, not a page-level main landmark; the app shell owns the single page main (U4). */}
      <section aria-label="Analytics" className="flex-1 overflow-auto p-[var(--card-padding)]">
        <div className="mx-auto max-w-7xl">
          <AnalyticsHub />
        </div>
      </section>
    </div>
  );
}
