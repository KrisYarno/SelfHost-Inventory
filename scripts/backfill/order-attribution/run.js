#!/usr/bin/env node
//
// W2-2 — the order-attribution backfill (design REV-2 §W2 "Backfill", pack seam S6).
//
// Copies the order a deduction's audit event names onto the inventory_logs rows
// that event describes. A FORWARD REPAIR, not history: its value is proportional
// to how long the accrual has been running, and it can say nothing about the
// movements that happened before 2026-08-13.
//
// TWO EVIDENCE SOURCES, one machinery (reference-resolution round):
//   `selected`            — 0b-2's `details.selectedExternalOrderId`, resolved
//                           and membership-checked BEFORE it was written, so it
//                           is copied without re-validation.
//   `reference-resolved`  — `details.orderReference`, the free text a packer
//                           TYPED. Never validated by anything, so it earns its
//                           way in only by matching exactly ONE
//                           `external_orders.orderNumber`. This is the source
//                           that actually exists in production: the structured
//                           key has never once been written there (0 of 1,897
//                           events), and all 10 distinct typed references
//                           resolve exactly.
// The summary reports the two SEPARATELY — they do not carry the same
// confidence and must never be read as one number.
//
// STANDALONE. It imports @prisma/client and its own pure planner and NOTHING
// else — no app/, no lib/, nothing that drags next/server. It is meant to be run
// BY THE ORCHESTRATOR against the dev stack's database.
//
// Usage:
//   DATABASE_URL='mysql://user:pass@host:3306/db' \
//     node scripts/backfill/order-attribution/run.js --until=<ISO> [--apply] [options]
//
// Options:
//   --until=<ISO>        REQUIRED. The W2 deploy moment — the instant the live
//                        route started sending an intent with every deduction.
//                        BEFORE it, an event with no intent key had nowhere to
//                        record one and its rows are backfillable; AFTER it, the
//                        same event is a STALE CLIENT, and the live route read
//                        the missing intent as `other` and left the movement
//                        unattributed ON PURPOSE. Filling those rows would
//                        manufacture the attribution the route declined, so the
//                        script refuses to run rather than guess which era a row
//                        belongs to. Events that DO carry an intent are judged on
//                        it whatever their date. (Take the value from the deploy's
//                        `/api/version` builtAt.)
//   --apply              WRITE. Without it this is a DRY RUN and no statement
//                        other than a SELECT is ever issued.
//   --since=YYYY-MM-DD   Only examine accrual events created on/after this date.
//                        Optional; a narrowing for large audit tables. When set,
//                        every "unmatched"/"skipped" figure in the summary is a
//                        statement about the WINDOW, not about all of history —
//                        the summary says so itself. Unrelated to --until, which
//                        classifies rather than narrows.
//   --json=<path>        Also write the summary as JSON here.
//   --help               Print this header.
//
// ---------------------------------------------------------------------------
// IDEMPOTENCY PROOF (by construction — not by convention, not by a flag)
// ---------------------------------------------------------------------------
// Every write this script can issue is exactly this statement:
//
//     UPDATE inventory_logs SET orderRecordId = ?
//      WHERE id IN (...) AND batchId = ? AND logType = 'SALE'
//        AND orderRecordId IS NULL
//
// The predicate `orderRecordId IS NULL` is FALSIFIED BY THE WRITE ITSELF. After
// the first run every row the script touched has a non-NULL orderRecordId, so on
// the second run the same statement matches those rows zero times. Running it N
// times therefore has the same effect as running it once, for every N >= 1, and
// for every interleaving with live traffic: a row that the live W2-1 stamping
// path claims between this script's SELECT and its UPDATE simply falls out of
// the WHERE, and is reported as `rowsRaced` rather than overwritten.
//
// The planner reaches the same conclusion independently — it only ever proposes
// rows it just read as NULL — but the plan is NOT what makes this safe. The
// WHERE is. The plan can be stale; the WHERE cannot.
//
// This script issues no INSERT, no DELETE, no DDL, and writes no column other
// than inventory_logs.orderRecordId. Each batch is its own single-statement
// write (no long-held transaction), so an interrupted run is resumable by
// re-running it — see above for why that is free.
//
// ---------------------------------------------------------------------------
// NO RE-VALIDATION — of the STRUCTURED id (design, verbatim)
// ---------------------------------------------------------------------------
// "NO re-validation (validated at write; re-checking with no session would drop
// admin-accrued rows)". The accrued id was resolved and membership-checked
// server-side by lib/orders/resolve-selected-order.ts before it was written.
// This script has no session and no actor, so any check it invented would
// evaluate a different predicate than the one that admitted the row — and would
// discard correct rows, notably every id an admin accrued across companies. The
// id is copied as recorded.
//
// THE REFERENCE SOURCE IS THE OTHER CASE and the distinction matters: free text
// was never validated at write, so there is no earlier decision to preserve.
// Its bar is set HERE and it is the exact-unique match (see ./plan.js). No
// membership predicate is applied to it either — for the same structural reason
// as above (no session, no actor) — which is why the bar is uniqueness of a
// number rather than a permission: a reference that names exactly one order in
// the whole system is not a claim about who may see it, it is an identification.
//
// PII DISCIPLINE (order-pipeline precedent, same as the 0a diagnostics): every
// projection here is ids, dates, counts and enum values. `details` is touched
// only through JSON path extraction of the three keys named below. THE TYPED
// REFERENCE ITSELF NEVER LEAVES THIS PROCESS: it is a free-text field, which is
// exactly where a customer name arrives, so it is used as a lookup key and is
// never written into the report, the summary or a skip entry (pinned). No
// customer field, no address, no note body, no product name is ever selected or
// printed.
//
const fs = require("fs");
const path = require("path");

const { PrismaClient } = require("@prisma/client");

const {
  ACCRUAL_ACTION_TYPE,
  ACCRUAL_DETAILS_KEY,
  ACCRUAL_REFERENCE_KEY,
  ACCRUAL_INTENT_KEY,
  ACCRUAL_LOG_TYPE,
  ATTRIBUTION_SOURCE,
  SKIP_CLASS,
  isUsableOrderReference,
  normalizeOrderReference,
  buildBackfillPlan,
  executeBackfillPlan,
} = require("./plan");

/** IN-list chunk size — keeps the packet off the max_allowed_packet cliff. */
const CHUNK = 500;

function parseArgs(argv) {
  const opts = { apply: false, since: null, until: null, json: null, help: false };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`Unexpected argument: ${arg}`);
    const [, key, rawValue] = m;
    const value = rawValue ?? "";
    switch (key) {
      case "apply":
        opts.apply = true;
        break;
      case "since":
        opts.since = value;
        break;
      case "until":
        opts.until = value;
        break;
      case "json":
        opts.json = value;
        break;
      case "help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }
  return opts;
}

/**
 * The ONE cutoff parser (W2FD-1): an ISO-8601 instant with an EXPLICIT
 * offset — `Z` or `+HH:MM`/`-HH:MM` — or null. Both the validator and the
 * planner call this, so the instant the operator was told is valid is the
 * instant the planner classifies against, on every host, in every timezone.
 */
const CUTOFF_SHAPE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function parseCutoff(raw) {
  if (typeof raw !== "string" || !CUTOFF_SHAPE.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function validate(opts) {
  const errors = [];
  // W2S-2. Named refusal, in BOTH modes: a dry run that misclassified an event
  // would be read as a plan and applied later. The message carries the REASON,
  // because an operator told only "required" would pass today's date and quietly
  // re-attribute every stale-client event the live route had declined.
  if (opts.until === null || opts.until === "") {
    errors.push(
      "--until=<ISO timestamp> is REQUIRED: it is the W2 deploy moment. An event " +
        "with no intent key means 'nowhere to record one' BEFORE that instant and " +
        "'the live route defaulted to other and left it unattributed' AFTER it — " +
        "without the boundary this script cannot tell those apart, so it will not guess."
    );
  } else if (parseCutoff(opts.until) === null) {
    // W2FD-1: `Date.parse` alone accepted timezone-less and locale forms and
    // resolved them in the HOST timezone — the same command meant different
    // instants on an MDT laptop and a UTC server, and the difference is a
    // window in which a stale no-intent event flips to "pre-cutoff" and gets
    // attributed. The cutoff must carry its own offset.
    errors.push(
      "--until must be an ISO-8601 instant WITH an explicit offset " +
        "(e.g. 2026-08-14T19:13:29Z or 2026-08-14T13:13:29-06:00) — " +
        "timezone-less and locale forms resolve in the host timezone and " +
        "would move the cutoff"
    );
  }
  if (opts.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    errors.push("--since must be YYYY-MM-DD");
  }
  if (opts.json !== null && opts.json.length === 0) {
    errors.push("--json=<path> needs a path");
  }
  return errors;
}

/** Host + database of the connection, WITHOUT credentials. Secrets never print. */
function describeConnection(url) {
  if (!url) return { host: null, database: null, ok: false };
  try {
    const u = new URL(url);
    return {
      host: `${u.hostname}${u.port ? `:${u.port}` : ""}`,
      database: u.pathname.replace(/^\//, "") || null,
      ok: true,
    };
  } catch {
    return { host: null, database: null, ok: false };
  }
}

function toNumber(v) {
  if (typeof v === "bigint") return Number(v);
  return Number(v);
}

/**
 * The accrual events. Scoped by actionType AND by the presence of EITHER
 * evidence key, because INVENTORY_BULK_UPDATE is written by other paths (the
 * admin mass-update, for one) that carry neither.
 *
 * The `OR` is the reference-resolution round's widening. Before it this query
 * asked only for the structured key — and in production that set is EMPTY, which
 * is how a clean-zero backfill ran three passes against 1,897 events that were
 * carrying the answer in the other column all along.
 */
async function selectAccrualEvents(prisma, since) {
  const params = [];
  let sql =
    "SELECT id, batchId, createdAt, " +
    `JSON_UNQUOTE(JSON_EXTRACT(details, '$.\"${ACCRUAL_DETAILS_KEY}\"')) AS accruedOrderId, ` +
    // W2S-3: JSON_UNQUOTE flattens every JSON scalar to a string, so the value
    // alone cannot say whether the accrual recorded an id or a number, a boolean,
    // an array or an object. JSON_TYPE is the only witness; the planner requires
    // it to read STRING before it will copy anything into the ledger.
    `JSON_TYPE(JSON_EXTRACT(details, '$.\"${ACCRUAL_DETAILS_KEY}\"')) AS accruedOrderIdType, ` +
    // The free-text key, under the SAME type discipline for the same reason.
    `JSON_UNQUOTE(JSON_EXTRACT(details, '$.\"${ACCRUAL_REFERENCE_KEY}\"')) AS orderReference, ` +
    `JSON_TYPE(JSON_EXTRACT(details, '$.\"${ACCRUAL_REFERENCE_KEY}\"')) AS orderReferenceType, ` +
    `JSON_UNQUOTE(JSON_EXTRACT(details, '$.\"${ACCRUAL_INTENT_KEY}\"')) AS intent, ` +
    // W2S-2: JSON_TYPE is NULL when the PATH does not exist and 'NULL' when the
    // value is JSON null — the only way to tell "this client never mentioned
    // intent" from "it said nothing meaningful".
    `JSON_TYPE(JSON_EXTRACT(details, '$.\"${ACCRUAL_INTENT_KEY}\"')) AS intentType ` +
    "FROM audit_logs " +
    "WHERE actionType = ? " +
    `AND (JSON_EXTRACT(details, '$.\"${ACCRUAL_DETAILS_KEY}\"') IS NOT NULL ` +
    `OR JSON_EXTRACT(details, '$.\"${ACCRUAL_REFERENCE_KEY}\"') IS NOT NULL)`;
  params.push(ACCRUAL_ACTION_TYPE);
  if (since) {
    sql += " AND createdAt >= ?";
    params.push(`${since} 00:00:00`);
  }
  sql += " ORDER BY id";

  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  return rows.map((r) => ({
    auditLogId: toNumber(r.id),
    batchId: r.batchId ?? null,
    createdAt: r.createdAt ?? null,
    accruedOrderId: r.accruedOrderId ?? null,
    accruedOrderIdType: r.accruedOrderIdType ?? null,
    orderReference: r.orderReference ?? null,
    orderReferenceType: r.orderReferenceType ?? null,
    intent: r.intent ?? null,
    intentType: r.intentType ?? null,
  }));
}

/**
 * Candidate orders for the references these events carry.
 *
 * A READ, and a narrow one: only references that already passed the planner's
 * shape bar are asked about, so a run whose events carry no usable reference
 * issues NO statement here at all (which is what keeps the structured-only path
 * byte-identical to the pre-round script).
 *
 * The `IN (...)` is a CANDIDATE fetch under MySQL's case- and pad-insensitive
 * collation; the planner decides exact equality and uniqueness itself. Doing it
 * the other way — trusting the collation — would let `12345 ` and `12345`
 * silently become the same order number, which is precisely the kind of "close
 * enough" this bar exists to refuse.
 */
async function selectOrderNumberMatches(prisma, references) {
  const out = [];
  for (let i = 0; i < references.length; i += CHUNK) {
    const chunk = references.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, orderNumber FROM external_orders WHERE orderNumber IN (${placeholders})`,
      ...chunk
    );
    for (const r of rows) {
      out.push({ orderNumber: r.orderNumber ?? null, orderId: r.id ?? null });
    }
  }
  return out;
}

/** Every ledger row belonging to the collected batches — stamped ones included. */
async function selectLedgerRows(prisma, batchIds) {
  const out = [];
  for (let i = 0; i < batchIds.length; i += CHUNK) {
    const chunk = batchIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, batchId, logType, orderRecordId FROM inventory_logs WHERE batchId IN (${placeholders})`,
      ...chunk
    );
    for (const r of rows) {
      out.push({
        id: toNumber(r.id),
        batchId: r.batchId ?? null,
        logType: r.logType ?? null,
        orderRecordId: r.orderRecordId ?? null,
      });
    }
  }
  return out;
}

/**
 * THE write. The only one. Read the idempotency proof in the header before
 * changing a character of this WHERE clause — every safety property this script
 * has is in it.
 */
function makeWriter(prisma) {
  return async function updateRows({ batchId, orderRecordId, logIds }) {
    let affected = 0;
    for (let i = 0; i < logIds.length; i += CHUNK) {
      const chunk = logIds.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      affected += toNumber(
        await prisma.$executeRawUnsafe(
          "UPDATE inventory_logs SET orderRecordId = ? " +
            `WHERE id IN (${placeholders}) AND batchId = ? AND logType = ? ` +
            "AND orderRecordId IS NULL",
          orderRecordId,
          ...chunk,
          batchId,
          ACCRUAL_LOG_TYPE
        )
      );
    }
    return affected;
  };
}

function formatSummary(report) {
  const { summary, execution, options } = report;
  const lines = [];
  lines.push("");
  lines.push(execution.applied ? "  MODE: APPLY (rows were written)" : "  MODE: DRY RUN (nothing was written)");
  lines.push(`  window: ${options.since ? `events created on/after ${options.since}` : "all accrual events"}`);
  lines.push(
    `  cutoff: ${options.until} — events with NO intent key are only fillable BEFORE it`
  );
  lines.push("");
  const pad = (label) => `${label} ${".".repeat(Math.max(1, 30 - label.length))}`;

  lines.push("  accrual events");
  lines.push(`    ${pad("examined")} ${summary.eventsExamined}`);
  lines.push(`    ${pad("linkable to a batch")} ${summary.eventsLinkable}`);
  for (const [cls, n] of Object.entries(summary.eventsSkippedByClass)) {
    lines.push(`    ${pad(`skipped [${cls}]`)} ${n}`);
  }
  lines.push("");
  lines.push("  batches");
  lines.push(`    ${pad("examined")} ${summary.batchesExamined}`);
  lines.push(`    ${pad("planned")} ${summary.batchesPlanned}`);
  for (const [cls, n] of Object.entries(summary.batchesSkippedByClass)) {
    lines.push(`    ${pad(`skipped [${cls}]`)} ${n}`);
  }
  lines.push("");
  // WHICH EVIDENCE. Never a single "batches planned" figure: `selected` was
  // proven server-side before it was written, `reference-resolved` is a number a
  // human typed that happens to name exactly one order. Both are honest; they
  // are not the same claim, and an operator deciding whether to --apply is
  // deciding about the mix.
  lines.push("  attributed by evidence (rows / batches)");
  for (const source of Object.values(ATTRIBUTION_SOURCE)) {
    const batches = summary.batchesPlannedBySource[source] || 0;
    const rows = summary.rowsToFillBySource[source] || 0;
    lines.push(`    ${pad(`[${source}]`)} ${rows} / ${batches}`);
  }
  lines.push("");
  lines.push("  ledger rows");
  lines.push(`    ${pad("examined")} ${summary.rowsExamined}`);
  lines.push(`    ${pad("to fill")} ${summary.rowsToFill}`);
  lines.push(`    ${pad("already stamped (left alone)")} ${summary.rowsAlreadyStamped}`);
  lines.push(`    ${pad("  ...with a DIFFERENT id")} ${summary.rowsAlreadyStampedDiffering}`);
  lines.push(`    ${pad("skipped, not filled")} ${summary.rowsSkipped}`);
  for (const [cls, n] of Object.entries(summary.rowsSkippedByClass)) {
    lines.push(`    ${pad(`  [${cls}]`)} ${n}`);
  }
  lines.push("");
  lines.push("  written");
  lines.push(`    ${pad("rows")} ${execution.rowsWritten}`);
  lines.push(`    ${pad("batches")} ${execution.batchesWritten}`);
  lines.push(`    ${pad("raced (stamped meanwhile)")} ${execution.rowsRaced}`);
  lines.push("");
  if (!execution.applied && summary.rowsToFill > 0) {
    lines.push("  Re-run with --apply to write the planned rows.");
    lines.push("");
  }
  if (summary.rowsAlreadyStampedDiffering > 0) {
    lines.push(
      "  NOTE: rows already carry an order id that DIFFERS from the accrual. " +
        "Nothing was overwritten (fill-only). This is a signal worth reading, not a failure."
    );
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Run the backfill and RETURN the report. Exposed so a caller (a test harness,
 * or a wave-close script) can consume the same object that gets printed.
 */
async function runBackfill(prisma, opts) {
  const events = await selectAccrualEvents(prisma, opts.since);
  // The shape bar decides what we ASK about, using the planner's own rule so the
  // question and the answer can never be scoped differently.
  const references = [
    ...new Set(
      events
        .filter((e) => isUsableOrderReference(e.orderReference, e.orderReferenceType))
        .map((e) => normalizeOrderReference(e.orderReference))
    ),
  ].sort();
  const orderNumberMatches = await selectOrderNumberMatches(prisma, references);
  const batchIds = [...new Set(events.map((e) => e.batchId).filter(Boolean))].sort();
  const ledgerRows = await selectLedgerRows(prisma, batchIds);

  // W2FD-1: the same strict parser validation used — never a bare `new Date`.
  const plan = buildBackfillPlan({
    events,
    ledgerRows,
    orderNumberMatches,
    cutoff: parseCutoff(opts.until),
  });
  const execution = await executeBackfillPlan(plan, {
    apply: opts.apply,
    updateRows: makeWriter(prisma),
  });

  return {
    script: "backfill/order-attribution",
    generatedAt: new Date().toISOString(),
    options: { apply: opts.apply, since: opts.since, until: opts.until },
    accrual: {
      actionType: ACCRUAL_ACTION_TYPE,
      detailsKey: ACCRUAL_DETAILS_KEY,
      referenceKey: ACCRUAL_REFERENCE_KEY,
      referenceBar: "trimmed reference == exactly ONE external_orders.orderNumber",
      logType: ACCRUAL_LOG_TYPE,
      linkage: "audit_logs.batchId = inventory_logs.batchId",
    },
    skipClasses: SKIP_CLASS,
    attributionSources: ATTRIBUTION_SOURCE,
    summary: plan.summary,
    // Ids only, per class — enough for the orchestrator to go look, never enough
    // to leak anything about a customer or an order's contents. The typed
    // reference is NOT here, deliberately: it is free text.
    skips: plan.skips,
    // Which evidence stamped which batch. Same discipline: ids and counts.
    evidence: plan.evidence,
    execution,
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[backfill] ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    // The header comment IS the usage text — print the real thing so the two can
    // never drift (the repo gitignores *.md, so no README travels with this).
    const lines = fs.readFileSync(__filename, "utf8").split("\n").slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    console.log(lines.slice(0, end === -1 ? lines.length : end).join("\n"));
    return;
  }

  const errors = validate(opts);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[backfill] ${e}`);
    process.exitCode = 1;
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "[backfill] DATABASE_URL is not set. Point it at the database to repair, explicitly."
    );
    process.exitCode = 1;
    return;
  }

  const connection = describeConnection(process.env.DATABASE_URL);
  console.log(
    "[backfill] order-attribution — audit accrual (selected id + resolved reference) -> inventory_logs.orderRecordId"
  );
  console.log(`[backfill] database: ${connection.host ?? "unknown"}/${connection.database ?? "unknown"}`);
  console.log(`[backfill] mode:     ${opts.apply ? "APPLY" : "DRY RUN"}`);

  const prisma = new PrismaClient({ log: ["warn", "error"] });
  try {
    const report = await runBackfill(prisma, opts);
    console.log(formatSummary(report));
    if (opts.json) {
      const target = path.resolve(opts.json);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`[backfill] summary written to ${target}`);
    }
    return report;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[backfill] FAILED: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, runBackfill, formatSummary, parseArgs, validate, parseCutoff, describeConnection };
