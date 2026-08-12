//
// Phase 0a — the READ-ONLY database access layer.
//
// Uses @prisma/client (a root dependency; devDependencies are pruned in the
// deployed image, and mysql2 is a devDependency) purely as a raw-SQL channel:
// $queryRawUnsafe with bound parameters, nothing else. There is no write path
// in this suite — no $executeRaw, no model mutations, no migrations.
//
// PII DISCIPLINE (binding, order-pipeline precedent): every projection in every
// module of this suite selects ids, counts, dates, quantities and status/enum
// fields only. Customer fields (customerEmail/customerName), addresses, raw
// platform payloads (rawPayload/platformStatusRaw) and notes bodies are NEVER
// selected. Actor USER IDS are projected; names and emails are not — the
// orchestrator maps ids offline. audit_logs.details is touched only through
// JSON path predicates for the D2 shape discriminator and the class (c)
// orderReference extraction; nothing else is projected out of it.
//
const { PrismaClient } = require("@prisma/client");

/** MySQL COUNT/SUM come back as BigInt; Decimal comes back as an object. */
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  // TINYINT(1) reaches us as a boolean on some driver paths and as 0/1 on
  // others; both must land on the same number.
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return v.length > 0 && v[0] !== 0 ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && typeof v.toString === "function") {
    const n = Number(v.toString());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Same, but never null — for counters where "no rows" genuinely means 0. */
function int(v) {
  const n = num(v);
  return n === null ? 0 : Math.trunc(n);
}

function date(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** MySQL booleans arrive as boolean / TINYINT / Buffer depending on driver path. */
function bool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  return int(v) !== 0;
}

/**
 * Host + database of the connection string, WITHOUT credentials. Printed at
 * startup so the operator can confirm which restore they are pointed at.
 * Secrets are never printed — user and password are dropped on the floor.
 */
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

function createClient() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Phase 0a runs against a StagingProduction restore " +
        "of a fresh prod dump — point DATABASE_URL at it explicitly."
    );
  }
  return new PrismaClient({ log: ["warn", "error"] });
}

/** Read-only query. `params` are bound (never interpolated). */
async function query(prisma, sql, params = []) {
  return prisma.$queryRawUnsafe(sql, ...params);
}

/**
 * Run `sql` once per chunk of `values`, splicing a `?, ?, ...` list in place of
 * the `__IN__` token. Keeps IN-lists off the packet-size cliff.
 */
async function queryChunkedIn(prisma, sql, values, chunkSize = 500, extraParams = []) {
  const out = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await prisma.$queryRawUnsafe(
      sql.replace("__IN__", placeholders),
      ...extraParams,
      ...chunk
    );
    out.push(...rows);
  }
  return out;
}

module.exports = {
  createClient,
  query,
  queryChunkedIn,
  describeConnection,
  num,
  int,
  date,
  bool,
};
