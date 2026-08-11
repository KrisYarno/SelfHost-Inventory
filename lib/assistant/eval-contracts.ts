/**
 * lib/assistant/eval-contracts.ts — the eval-report / user-report contracts
 * (spec C9 + REV-9; contract pack T10, seam S15).
 *
 * The ONE place the `assistant_eval_reports` payload shapes live: the admin-curated
 * scored run (`source: "eval-run"`), the user-initiated conversation report
 * (`source: "user-report"`), the two byte caps, the truthful-degradation walk, and
 * the canonical export serialization the byte-fidelity tests compare against.
 *
 * SERVER-ONLY. It reaches prisma transitively through `serializedBytes` — the same
 * canonical byte measurement the C2 message cap and the history budget use, which is
 * the point: three caps measuring "size" three different ways would be three
 * different contracts. Client-facing wire types live in `hooks/use-assistant-eval.ts`
 * (the 3.1 `use-assistant-usage.ts` precedent); a client may import TYPES from here,
 * never values.
 *
 * Next-free, like every lib/assistant module.
 */

import { z } from "zod";
import { serializedBytes } from "@/lib/assistant/threads";
import type { ThreadMessageDto } from "@/lib/assistant/thread-contracts";

/** Serialized byte caps (T10). UTF-8 bytes of the canonical serialized payload. */
export const EVAL_CAP_BYTES = 1_048_576;
export const REPORT_CAP_BYTES = 2_097_152;

/**
 * What replaces a shed tool OUTPUT in a user report. It is deliberately a visible
 * sentence rather than an empty value: a reader of the exported report must be able
 * to tell "the tool returned nothing" from "this report could not carry it".
 */
export const TOOL_OUTPUT_REPORT_MARKER = "[output truncated for report size]";

/** Excerpts, not transcripts: an eval run summarizes prod-dump-derived answers
 *  (spec C9). Enforced by the schema AT UPLOAD, not trimmed silently. */
export const ANSWER_EXCERPT_MAX = 500;

/** The reporter's own words about why they are reporting — bounded, optional. */
export const REPORTER_NOTE_MAX = 1_000;

export const EVAL_ENVIRONMENTS = ["dev", "staging", "production"] as const;
export type EvalEnvironment = (typeof EVAL_ENVIRONMENTS)[number];

export const EVAL_VERDICTS = ["pass", "fail", "mixed", "unscored"] as const;
export type EvalVerdict = (typeof EVAL_VERDICTS)[number];

export type EvalSource = "eval-run" | "user-report";

/**
 * One scored turn (spec C9). `toolCalls` is the list of tool NAMES the turn invoked:
 * the scored report is a summary that says WHICH tools ran, while the arguments and
 * outputs that would prove faithfulness live in the docs-repo corpus (and, for a user
 * report, in the full transcript below).
 *
 * Plain `z.object` (house rule) — no `.refine`; cross-field rules are post-parse
 * `assert*` helpers at the route.
 */
export const evalTurnSchema = z.object({
  conversation: z.string().min(1).max(200),
  turn: z.number().int().min(1),
  prompt: z.string().min(1).max(8_192),
  verdict: z.enum(EVAL_VERDICTS),
  notes: z.string().max(4_000),
  toolCalls: z.array(z.string().min(1).max(64)).max(64),
  answerExcerpt: z.string().max(ANSWER_EXCERPT_MAX),
});

/**
 * The uploaded scored run. `model` and `corpusRev` are REQUIRED here and nullable in
 * the table on purpose (spec C1): an eval run always knows both, a user report never
 * does, and the columns must not be filled with a plausible-looking guess.
 */
export const evalReportSchema = z.object({
  runAt: z.string().datetime(),
  environment: z.enum(EVAL_ENVIRONMENTS),
  model: z.string().min(1).max(64),
  corpusRev: z.string().min(1).max(64),
  turns: z.array(evalTurnSchema).min(1),
});

export type EvalReport = z.infer<typeof evalReportSchema>;

/** The reporter's request body. The transcript is NEVER uploaded — the server reads
 *  it from its own store, so a client cannot report words nobody said. */
export const reportRequestSchema = z.object({
  reporterNote: z.string().trim().max(REPORTER_NOTE_MAX).optional(),
});

/**
 * The stored user report (T10). `turns` carries the FULL transcript — prompts,
 * answers, tool calls AND their outputs (Kris's call: tool output is the ground
 * truth AT REPORT TIME, and without it QA means re-running tools against drifted
 * data). `truncation` rides INSIDE the payload so an exported report always
 * discloses its own completeness.
 */
export type UserReport = {
  threadId: string;
  userId: number;
  reporterNote?: string;
  turns: Array<{ messages: ThreadMessageDto[] }>;
  truncation: { applied: boolean; omittedToolOutputCount: number };
};

export type EvalExportDto = {
  id: number;
  runAt: string;
  environment: EvalEnvironment;
  model: string | null;
  corpusRev: string | null;
  source: EvalSource;
  report: unknown;
  createdAt: string;
};

/** The `assistant_eval_reports` columns the export reads — structural, so this
 *  module stays prisma-type-free. */
export type EvalReportRow = {
  id: number;
  runAt: Date;
  environment: string;
  model: string | null;
  corpusRev: string | null;
  source: string;
  report: unknown;
  createdAt: Date;
};

/**
 * The FULL row, never `report` alone (T10): the discriminating columns are what make
 * an exported file self-describing once it is sitting in the docs corpus.
 *
 * `environment` and `source` pass through AS STORED (the 3.1 `kind` precedent) —
 * relabelling a value the database holds would be a fabrication, and the write sites
 * are the only producers of these columns.
 */
export function toEvalExportDto(row: EvalReportRow): EvalExportDto {
  return {
    id: row.id,
    runAt: row.runAt.toISOString(),
    environment: row.environment as EvalEnvironment,
    model: row.model,
    corpusRev: row.corpusRev,
    source: row.source as EvalSource,
    report: row.report,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The canonical export bytes (G2-12). The field order is written out HERE rather
 * than inherited from whatever object the caller happened to build, so a route that
 * assembles its DTO differently still ships byte-identical files.
 */
export function serializeEvalExport(dto: EvalExportDto): string {
  // INDENTED canonical form (micro round 2026-08-11): the first real prod export
  // was one 40K-char line and put the reader's editor into read-only mode. Corpus
  // files exist to be READ. Two-space indent, fixed key order — still deterministic,
  // and G2-12 holds by construction because every fidelity comparator calls THIS
  // function.
  return JSON.stringify(
    {
      id: dto.id,
      runAt: dto.runAt,
      environment: dto.environment,
      model: dto.model,
      corpusRev: dto.corpusRev,
      source: dto.source,
      report: dto.report,
      createdAt: dto.createdAt,
    },
    null,
    2,
  );
}

/** The same rule `lib/assistant/threads.ts` sheds history by: a resolved tool part
 *  carrying a real output. Input-only and errored states are left alone (they are
 *  small, and an error IS the finding a report is often filed about). */
function isToolOutputPart(part: unknown): part is Record<string, unknown> {
  if (typeof part !== "object" || part === null) return false;
  const typed = part as { type?: unknown; state?: unknown };
  if (typeof typed.type !== "string") return false;
  if (!typed.type.startsWith("tool-") && typed.type !== "dynamic-tool") return false;
  return typed.state === "output-available";
}

/**
 * Truthful degradation (spec C9 REV-9). Walks turns OLDEST-first, messages in
 * transcript order, tool outputs in part order, replacing ONE output at a time with
 * the marker and re-measuring after each — so the newest turns, the ones a reviewer
 * actually needs, stay complete, and the disclosure counts exactly what went.
 *
 * Prompts, answers and whole turns are NEVER removed. When every output is already a
 * marker and the payload still exceeds the cap, this returns `fits: false` and the
 * route refuses the report (413): a stored report that had dropped the user's own
 * words would be a false record of the conversation.
 *
 * The re-measure per replacement is deliberate (the disclosure's own digits change
 * the payload size) and costs nothing in the overwhelming case: a report that
 * already fits never enters the loop.
 */
export function truncateUserReport(
  report: UserReport,
  capBytes: number,
): { fits: boolean; report: UserReport } {
  if (serializedBytes(report) <= capBytes) return { fits: true, report };

  // Structural copy down to the parts arrays: the rows handed in came from the
  // database read and must not be rewritten under the caller.
  const working: UserReport = {
    ...report,
    turns: report.turns.map((turn) => ({
      messages: turn.messages.map((message) => ({
        ...message,
        parts: Array.isArray(message.parts) ? [...message.parts] : message.parts,
      })),
    })),
    truncation: { ...report.truncation },
  };

  for (const turn of working.turns) {
    for (const message of turn.messages) {
      if (!Array.isArray(message.parts)) continue;
      const parts = message.parts as unknown[];
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (!isToolOutputPart(part)) continue;
        parts[i] = { ...part, output: TOOL_OUTPUT_REPORT_MARKER };
        working.truncation.applied = true;
        working.truncation.omittedToolOutputCount += 1;
        if (serializedBytes(working) <= capBytes) return { fits: true, report: working };
      }
    }
  }

  return { fits: false, report: working };
}
