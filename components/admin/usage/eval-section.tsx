"use client";

/**
 * components/admin/usage/eval-section.tsx — the spec-C9 bounded live-eval +
 * user-report section, mounted in the anchor task 3.1 left on the usage page.
 *
 * This section is the page's ONE labelled exception to "no conversation text here"
 * (spec C8): it shows admin-curated corpus prompts and excerpts from the latest
 * SCORED RUN. What it does NOT show is a reported conversation — a user report is a
 * full transcript of somebody's real work, and it leaves the database only through
 * the deliberate per-row export, never as prose an admin scrolls past.
 *
 * Truthful data: a user report's NULL model / corpusRev renders a named reason, and
 * scoring is informative — no pass rate is computed here, because the verdicts are
 * hand-assigned and a percentage would dress them up as a measurement.
 */

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { evalExportHref, useAssistantEvalReports } from "@/hooks/use-assistant-eval";
import type { AssistantEvalSummary } from "@/hooks/use-assistant-eval";

export const EVAL_SECTION_HEADING = "Assistant evaluation";

export const EVAL_SECTION_NOTE =
  "Scored runs of the curated prompt corpus, and conversations users chose to report. " +
  "Scoring is informative — it never blocks a release.";

export const EVAL_REPORT_PRIVACY_NOTE =
  "A reported conversation is shown here as a row, not as text: the transcript is " +
  "downloaded deliberately, by exporting it.";

export const EVAL_EMPTY_REASON =
  "No eval runs or reports have been recorded yet — nothing has been evaluated, which is not the same as everything passing.";

export const EVAL_NOT_APPLICABLE_LABEL = "not applicable";

/** A user report's empty model/corpus cells are INHERENT to the row type, and the
 *  cell says so itself (micro round 2026-08-11 — the generic label read as
 *  breakage to the first real reporter). */
export const EVAL_USER_REPORT_LABEL = "n/a for user reports";

export const EVAL_LATEST_HEADING = "Latest scored run";

export const EVAL_HISTORY_HEADING = "Run history";

/** The C9 per-turn shape (spec C9). Read defensively: the payload is stored JSON, and
 *  a row written by an older uploader must render as what it is, never as a crash. */
interface ScoredTurn {
  conversation?: unknown;
  turn?: unknown;
  prompt?: unknown;
  verdict?: unknown;
  notes?: unknown;
  toolCalls?: unknown;
  answerExcerpt?: unknown;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function scoredTurns(report: unknown): ScoredTurn[] {
  if (typeof report !== "object" || report === null) return [];
  const turns = (report as { turns?: unknown }).turns;
  return Array.isArray(turns) ? (turns as ScoredTurn[]) : [];
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  // An unparseable timestamp renders as itself rather than "Invalid Date".
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** An absent value is a FACT here and gets words — which words depends on the row:
 *  a user report's absence is inherent to its type; an eval-run's is simply not
 *  recorded. (G1-2: one helper, one absence semantics.) */
function orAbsent(value: string | null, source: string) {
  if (value) return <span>{value}</span>;
  return (
    <span className="text-muted-foreground">
      {source === "user-report" ? EVAL_USER_REPORT_LABEL : EVAL_NOT_APPLICABLE_LABEL}
    </span>
  );
}

function HistoryRow({ item }: { item: AssistantEvalSummary }) {
  return (
    <tr data-testid={`eval-history-${item.id}`} className="border-t border-border align-top">
      <td className="px-3 py-2 text-body-sm">{formatWhen(item.runAt)}</td>
      <td className="px-3 py-2 text-body-sm">{item.source}</td>
      <td className="px-3 py-2 text-body-sm">{item.environment}</td>
      <td className="px-3 py-2 text-body-sm">{orAbsent(item.model, item.source)}</td>
      <td className="px-3 py-2 text-body-sm">{orAbsent(item.corpusRev, item.source)}</td>
      <td className="px-3 py-2 text-body-sm">
        <a
          href={evalExportHref(item.id)}
          download
          className="underline underline-offset-2 hover:text-foreground"
        >
          Export JSON
        </a>
      </td>
    </tr>
  );
}

export function EvalSection() {
  const query = useAssistantEvalReports();
  const data = query.data;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-6">
      <div className="space-y-1">
        <h2 className="text-h4">{EVAL_SECTION_HEADING}</h2>
        <p className="text-body-sm text-muted-foreground">{EVAL_SECTION_NOTE}</p>
        <p className="text-body-sm text-muted-foreground">{EVAL_REPORT_PRIVACY_NOTE}</p>
      </div>

      {query.isLoading ? (
        <div className="space-y-3" data-testid="eval-loading">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-[160px] w-full" />
        </div>
      ) : query.isError || !data ? (
        <div className="rounded-md border border-negative-border bg-negative-muted p-4">
          <p className="text-body text-negative-foreground">
            Could not load assistant eval reports.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : data.latest === null && data.history.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{EVAL_EMPTY_REASON}</p>
      ) : (
        <>
          {data.latest && (
            <div className="space-y-2" data-testid="eval-latest">
              <h3 className="text-label uppercase text-muted-foreground">{EVAL_LATEST_HEADING}</h3>
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-body-sm">
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Run at</dt>
                  <dd>{formatWhen(data.latest.runAt)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Environment</dt>
                  <dd>{data.latest.environment}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Model</dt>
                  <dd>{orAbsent(data.latest.model, "eval-run")}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Corpus</dt>
                  <dd>{orAbsent(data.latest.corpusRev, "eval-run")}</dd>
                </div>
              </dl>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse">
                  <thead>
                    <tr className="text-left text-label uppercase text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Conversation</th>
                      <th className="px-3 py-2 font-medium">Turn</th>
                      <th className="px-3 py-2 font-medium">Verdict</th>
                      <th className="px-3 py-2 font-medium">Prompt</th>
                      <th className="px-3 py-2 font-medium">Notes</th>
                      <th className="px-3 py-2 font-medium">Answer excerpt</th>
                      <th className="px-3 py-2 font-medium">Tools</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scoredTurns(data.latest.report).map((t, index) => (
                      <tr
                        key={`${asText(t.conversation)}-${String(t.turn)}-${index}`}
                        className="border-t border-border align-top"
                      >
                        {/* Corpus text renders as TEXT NODES, never markdown: it is
                            model-adjacent content on an admin page. */}
                        <td className="px-3 py-2 text-body-sm">{asText(t.conversation)}</td>
                        <td className="px-3 py-2 text-body-sm tabular-nums">
                          {typeof t.turn === "number" ? t.turn : ""}
                        </td>
                        <td className="px-3 py-2 text-body-sm">{asText(t.verdict)}</td>
                        <td className="px-3 py-2 text-body-sm">{asText(t.prompt)}</td>
                        <td className="px-3 py-2 text-body-sm">{asText(t.notes)}</td>
                        {/* W3S-2: the bounded answer being scored (<=500 chars at
                            upload, spec C9) — a TEXT NODE like every corpus string;
                            without it the admin cannot inspect what the verdict
                            judged. */}
                        <td className="px-3 py-2 text-body-sm" data-testid="eval-answer-excerpt">
                          {asText(t.answerExcerpt)}
                        </td>
                        <td className="px-3 py-2 text-body-sm">
                          {Array.isArray(t.toolCalls) ? t.toolCalls.join(", ") : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-label uppercase text-muted-foreground">{EVAL_HISTORY_HEADING}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse">
                <thead>
                  <tr className="text-left text-label uppercase text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Run at</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Environment</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Corpus</th>
                    <th className="px-3 py-2 font-medium">Export</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((item) => (
                    <HistoryRow key={item.id} item={item} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-body-sm text-muted-foreground">{data.historyNote}</p>
          </div>
        </>
      )}
    </section>
  );
}
