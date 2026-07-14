"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  Loader2,
  RefreshCw,
  Plug,
  HardDrive,
  ClipboardList,
  DatabaseZap,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { RebuildHistoryTable } from "@/components/admin/rebuild-history-table";
import {
  useOpsHealth,
  useTriggerRebuild,
  useSetPlatformWriteKillSwitch,
  type OpsHealthResponse,
  type AttentionItem,
  type RebuildJobHealth,
  type PlatformWritesHealth,
} from "@/hooks/use-admin";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";

// Triage-first ops health (spec §11 D-L1/D-L4/D-L7): verdict strip -> needs-attention
// list -> row-based workspaces separated by dividers (never a card mosaic) ->
// rebuild split into current-health rows / a separate history table / Run-now ON
// the job row. Flat hierarchy: bg-surface + section rules, no shadowed Card stacks.

const VERDICT: Record<OpsHealthResponse["verdict"], { tone: StatusTone; Icon: typeof CheckCircle2; label: string }> = {
  ok: { tone: "positive", Icon: CheckCircle2, label: "All systems healthy" },
  degraded: { tone: "warning", Icon: AlertTriangle, label: "Degraded — needs attention" },
  failing: { tone: "negative", Icon: AlertOctagon, label: "Action needed" },
};

function severityMeta(sev: AttentionItem["severity"]): { tone: StatusTone; Icon: typeof AlertTriangle } {
  return sev === "negative"
    ? { tone: "negative", Icon: AlertOctagon }
    : { tone: "warning", Icon: AlertTriangle };
}

function relative(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(Math.abs(diff) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** One workspace row: status icon+badge · system/detail · action. */
function HealthRow({
  tone,
  Icon,
  status,
  title,
  detail,
  action,
}: {
  tone: StatusTone;
  Icon: typeof CheckCircle2;
  status: string;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <StatusBadge tone={tone} className="mt-0.5 inline-flex shrink-0 items-center gap-1">
          <Icon className="h-3 w-3" aria-hidden />
          {status}
        </StatusBadge>
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function SectionHeading({ Icon, children }: { Icon: typeof Plug; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 pt-4 text-sm font-semibold text-muted-foreground">
      <Icon className="h-4 w-4" aria-hidden />
      {children}
    </h3>
  );
}

export function OpsHealthSection() {
  const { data, isLoading, isError, refetch } = useOpsHealth();
  const trigger = useTriggerRebuild();
  const [confirmJob, setConfirmJob] = useState<string | null>(null);
  const [runningJob, setRunningJob] = useState<string | null>(null);

  async function run(job: "snapshots" | "sales", mode: "nightly" | "full") {
    setConfirmJob(null);
    setRunningJob(job);
    toast.info("Rebuild started");
    try {
      await trigger.mutateAsync({ job, mode });
      toast.success(`${job} rebuild finished`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rebuild failed");
    } finally {
      setRunningJob(null);
    }
  }

  if (isLoading) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <Skeleton className="h-6 w-48" />
        <div className="mt-4 space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section className="rounded-lg border border-negative-border bg-negative-muted p-4 text-negative-foreground">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertOctagon className="h-4 w-4" aria-hidden />
            Could not load system health.
          </p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </section>
    );
  }

  const v = VERDICT[data.verdict];

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-surface">
        {/* Verdict strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <div className="flex items-center gap-3">
            <StatusBadge tone={v.tone} className="inline-flex items-center gap-1.5 px-3 py-1 text-xs">
              <v.Icon className="h-4 w-4" aria-hidden />
              {v.label}
            </StatusBadge>
            <span className="text-sm text-muted-foreground">System health</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {/* Needs-attention list (severity-then-recency) */}
        {data.attention.length > 0 && (
          <div className="divide-y divide-border border-b border-border">
            {data.attention.map((a, i) => {
              const m = severityMeta(a.severity);
              return (
                <Link
                  key={i}
                  href={a.href}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                >
                  <StatusBadge tone={m.tone} className="inline-flex shrink-0 items-center gap-1">
                    <m.Icon className="h-3 w-3" aria-hidden />
                    {a.system}
                  </StatusBadge>
                  <span className="min-w-0 flex-1 truncate text-sm">{a.message}</span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              );
            })}
          </div>
        )}

        {/* Row workspaces */}
        <div className="space-y-1 px-4 pb-4">
          {/* Integrations */}
          <SectionHeading Icon={Plug}>Integrations</SectionHeading>
          {data.integrations.status === "unavailable" ? (
            <HealthRow tone="warning" Icon={AlertTriangle} status="Unavailable" title="Integration health could not be read." />
          ) : data.integrations.data.length === 0 ? (
            <HealthRow tone="neutral" Icon={CheckCircle2} status="None" title="No integrations configured." />
          ) : (
            <div className="divide-y divide-border">
              {data.integrations.data.map((it) => {
                const failing = !!it.lastSyncError;
                const warn = it.lockStale || it.webhookFailureCount > 0;
                const tone: StatusTone = failing ? "negative" : warn ? "warning" : "positive";
                const Icon = failing ? AlertOctagon : warn ? AlertTriangle : CheckCircle2;
                const status = failing ? "Failing" : warn ? "Degraded" : "Healthy";
                const detail = failing
                  ? `Order sync failing — ${it.lastSyncError!.message}`
                  : it.lockStale
                    ? "Sync lock stuck (over 5 minutes)"
                    : it.webhookFailureCount > 0
                      ? `${it.webhookFailureCount} webhook failures`
                      : `Last sync ${relative(it.lastSyncAt)}`;
                return (
                  <HealthRow
                    key={it.id}
                    tone={tone}
                    Icon={Icon}
                    status={status}
                    title={`${it.companyName || it.name} · ${it.platform}`}
                    detail={detail}
                  />
                );
              })}
            </div>
          )}

          {/* Backups */}
          <SectionHeading Icon={HardDrive}>Backups</SectionHeading>
          {data.backups.status === "unavailable" ? (
            <HealthRow tone="warning" Icon={AlertTriangle} status="Unavailable" title="Backup status could not be read." />
          ) : (
            (() => {
              const b = data.backups.data;
              if (b.volume === "unavailable") {
                return <HealthRow tone="negative" Icon={AlertOctagon} status="Volume unreadable" title="The backup volume could not be read." detail="Check that the /backup volume is mounted." action={<BackupLink />} />;
              }
              if (b.count === 0) {
                return <HealthRow tone="warning" Icon={AlertTriangle} status="None" title="No database backups yet." action={<BackupLink />} />;
              }
              const ageH = b.newest!.ageHours;
              const tone: StatusTone = ageH > 50 ? "negative" : ageH > 26 ? "warning" : "positive";
              const Icon = ageH > 50 ? AlertOctagon : ageH > 26 ? AlertTriangle : CheckCircle2;
              const status = ageH > 50 ? "Stale" : ageH > 26 ? "Aging" : "Current";
              return (
                <HealthRow
                  tone={tone}
                  Icon={Icon}
                  status={status}
                  title={`Newest backup ${relative(new Date(b.newest!.mtimeMs).toISOString())}`}
                  detail={`${b.count} backup${b.count === 1 ? "" : "s"} on the volume`}
                  action={<BackupLink />}
                />
              );
            })()
          )}

          {/* Pending reviews */}
          <SectionHeading Icon={ClipboardList}>Pending reviews</SectionHeading>
          {data.pendingReviews.status === "unavailable" ? (
            <HealthRow tone="warning" Icon={AlertTriangle} status="Unavailable" title="Pending-review counts could not be read." />
          ) : (
            (() => {
              const p = data.pendingReviews.data;
              const total = p.pendingUsers + p.pendingProducts + p.stagingReceived;
              if (total === 0) {
                return <HealthRow tone="positive" Icon={CheckCircle2} status="Clear" title="No items awaiting review." />;
              }
              return (
                <div className="divide-y divide-border">
                  {p.pendingProducts > 0 && (
                    <HealthRow tone="warning" Icon={AlertTriangle} status={String(p.pendingProducts)} title="Products awaiting review" action={<LinkAction href="/admin/product-review" label="Review" />} />
                  )}
                  {p.stagingReceived > 0 && (
                    <HealthRow tone="warning" Icon={AlertTriangle} status={String(p.stagingReceived)} title="Received items awaiting graduation" action={<LinkAction href="/pre-staging" label="Open" />} />
                  )}
                  {p.pendingUsers > 0 && (
                    <HealthRow tone="warning" Icon={AlertTriangle} status={String(p.pendingUsers)} title="Users awaiting approval" action={<LinkAction href="/admin/users" label="Review" />} />
                  )}
                </div>
              );
            })()
          )}

          {/* Platform writes — posture tile + the emergency stop (R-E9) */}
          <SectionHeading Icon={ShieldAlert}>Platform writes</SectionHeading>
          {data.platformWrites.status === "unavailable" ? (
            <HealthRow tone="warning" Icon={AlertTriangle} status="Unavailable" title="Platform-write posture could not be read." />
          ) : (
            <PlatformWritesRow health={data.platformWrites.data} />
          )}

          {/* Analytics rebuild — current-health rows + Run-now on the job row */}
          <SectionHeading Icon={DatabaseZap}>Analytics rebuild</SectionHeading>
          {data.rebuild.status === "unavailable" ? (
            <HealthRow tone="warning" Icon={AlertTriangle} status="Unavailable" title="Rebuild status could not be read." />
          ) : (
            <RebuildJobs
              rebuild={data.rebuild.data}
              confirmJob={confirmJob}
              runningJob={runningJob}
              onAskConfirm={setConfirmJob}
              onRun={run}
            />
          )}
        </div>
      </section>

      {/* Separate dense run-history table */}
      {data.rebuild.status === "ok" && (
        <section className="rounded-lg border border-border bg-surface p-4">
          <h3 className="mb-3 text-sm font-semibold">Rebuild history</h3>
          <RebuildHistoryTable runs={data.rebuild.data.runs} />
        </section>
      )}
    </div>
  );
}

function BackupLink() {
  return <LinkAction href="/admin/backup" label="Backups" />;
}

/**
 * Platform-write posture + the emergency stop (R-E9).
 *
 * The tile copy is the operator language from DESIGN.md ("Platform writes: OFF" /
 * "DRY RUN" / "ON — stock status only"; the invalid-env red state reads "OFF
 * (configuration not understood)"). The "Block all platform writes now" control
 * flips the kill switch instantly, no redeploy — and when it is engaged, a
 * prominent lift control appears.
 */
function PlatformWritesRow({ health }: { health: PlatformWritesHealth }) {
  const setKill = useSetPlatformWriteKillSwitch();

  // Tone: red when the config is broken; also red when writes are ON (that is
  // the state the owner most wants to notice on a live store). Kill-switch
  // engaged is a deliberate, safe state → neutral. Off/dry-run → positive.
  const tone: StatusTone = health.invalidEnv
    ? "negative"
    : health.effective === "on"
      ? "warning"
      : health.killSwitchEngaged
        ? "neutral"
        : "positive";
  const Icon = health.invalidEnv
    ? ShieldX
    : health.effective === "on"
      ? ShieldAlert
      : ShieldCheck;
  const status = health.invalidEnv
    ? "Misconfigured"
    : health.effective === "on"
      ? "ON"
      : health.effective === "dry-run"
        ? "Dry run"
        : "Off";

  async function toggle(engage: boolean) {
    try {
      await setKill.mutateAsync(engage);
      toast.success(engage ? "Platform writes blocked" : "Emergency stop lifted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the emergency stop");
    }
  }

  const action = health.killSwitchEngaged ? (
    <Button
      size="sm"
      variant="outline"
      disabled={setKill.isPending}
      onClick={() => toggle(false)}
    >
      {setKill.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
      Lift emergency stop
    </Button>
  ) : (
    <Button
      size="sm"
      variant="destructive"
      disabled={setKill.isPending}
      onClick={() => toggle(true)}
    >
      {setKill.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldX className="mr-2 h-4 w-4" />}
      Block all platform writes now
    </Button>
  );

  const detail = health.killSwitchEngaged
    ? "Emergency stop is engaged — every platform write is blocked."
    : health.invalidEnv
      ? `Configuration not understood (${health.invalidReasons.join(", ")}). Writes are off.`
      : health.effective === "on"
        ? `Writes are enabled for: ${health.capabilities.join(", ") || "no capabilities"}.`
        : health.effective === "dry-run"
          ? "Writes are logged but never sent."
          : "No platform writes will be sent.";

  return (
    <HealthRow tone={tone} Icon={Icon} status={status} title={health.label} detail={detail} action={action} />
  );
}

function LinkAction({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href={href}>{label}</Link>
    </Button>
  );
}

function RebuildJobs({
  rebuild,
  confirmJob,
  runningJob,
  onAskConfirm,
  onRun,
}: {
  rebuild: Extract<OpsHealthResponse["rebuild"], { status: "ok" }>["data"];
  confirmJob: string | null;
  runningJob: string | null;
  onAskConfirm: (job: string | null) => void;
  onRun: (job: "snapshots" | "sales", mode: "nightly" | "full") => void;
}) {
  return (
    <div className="divide-y divide-border">
      {/* Sidecar heartbeat row */}
      <HealthRow
        tone={rebuild.heartbeatStale ? "negative" : "positive"}
        Icon={rebuild.heartbeatStale ? AlertOctagon : CheckCircle2}
        status={rebuild.heartbeatStale ? "Not running" : "Running"}
        title="Rebuild sidecar"
        detail={rebuild.heartbeatStale ? "No recent heartbeat" : `Last heartbeat ${relative(rebuild.sidecarSeenAt)}`}
      />
      {rebuild.jobs.length === 0 ? (
        <HealthRow tone="neutral" Icon={CheckCircle2} status="Idle" title="No rebuild jobs have run yet." />
      ) : (
        rebuild.jobs.map((j) => (
          <RebuildJobRow
            key={j.job}
            job={j}
            confirming={confirmJob === j.job}
            running={runningJob === j.job}
            onAskConfirm={onAskConfirm}
            onRun={onRun}
          />
        ))
      )}
    </div>
  );
}

function jobTone(j: RebuildJobHealth): { tone: StatusTone; Icon: typeof CheckCircle2; status: string; detail: string } {
  if (j.lastError) return { tone: "negative", Icon: AlertOctagon, status: "Error", detail: j.lastError };
  if (j.lockStale) return { tone: "warning", Icon: AlertTriangle, status: "Lock stale", detail: "Rebuild lock is stale" };
  const stale = j.enabled && (!j.lastSuccessAt || Date.now() - new Date(j.lastSuccessAt).getTime() > 26 * 60 * 60 * 1000);
  if (stale) return { tone: "warning", Icon: AlertTriangle, status: "No recent run", detail: `Last success ${relative(j.lastSuccessAt)}` };
  return { tone: "positive", Icon: CheckCircle2, status: "Healthy", detail: `Last success ${relative(j.lastSuccessAt)}` };
}

function RebuildJobRow({
  job,
  confirming,
  running,
  onAskConfirm,
  onRun,
}: {
  job: RebuildJobHealth;
  confirming: boolean;
  running: boolean;
  onAskConfirm: (job: string | null) => void;
  onRun: (job: "snapshots" | "sales", mode: "nightly" | "full") => void;
}) {
  const t = jobTone(job);
  const jobKey = job.job as "snapshots" | "sales";

  const action = running ? (
    <Button size="sm" variant="outline" disabled>
      <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
      Running…
    </Button>
  ) : confirming ? (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Rebuild {jobKey}:</span>
      <Button size="sm" variant="outline" onClick={() => onRun(jobKey, "nightly")}>
        Nightly (recent window)
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRun(jobKey, "full")}>
        Full (entire history)
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onAskConfirm(null)}>
        Cancel
      </Button>
    </div>
  ) : (
    <Button size="sm" variant="outline" onClick={() => onAskConfirm(job.job)}>
      <RefreshCw className="mr-2 h-4 w-4" />
      Run rebuild
    </Button>
  );

  return <HealthRow tone={t.tone} Icon={t.Icon} status={t.status} title={job.job} detail={t.detail} action={action} />;
}
