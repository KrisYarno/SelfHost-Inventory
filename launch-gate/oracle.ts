/**
 * launch-gate/oracle.ts — the independent SQL oracle (spec C7 "Oracle"; contract
 * pack T8 CP-9; seam S10).
 *
 * `mysql2` raw ONLY. The whole point of the oracle is that it does not share a code
 * path with the thing under test: prisma computes what the app believes, this file
 * computes what the database actually contains.
 *
 * THE DIGEST (CP-9 — total and collision-free). A row is encoded column by column in
 * information_schema ordinal order, each column as either `N:\N;` (NULL) or
 * `V<octetLen>:<bytes>;`. The length prefix makes the byte stream self-delimiting,
 * so no separator is needed and no pair of distinct tables/rows can encode to the
 * same string by moving a delimiter across a column boundary. The table digest is
 * `MD5(COALESCE(GROUP_CONCAT(rowExpr ORDER BY <pk cols> SEPARATOR ''), ''))` — an
 * empty table digests as MD5('') rather than NULL.
 *
 * The reject list is deliberately loud: a non-allowlisted identifier, a table with
 * no primary key, a table with zero selectable columns, a GROUP_CONCAT truncation
 * warning, or an estimated stream larger than
 * LEAST(@@group_concat_max_len, @@max_allowed_packet) all THROW. A silently
 * truncated digest would turn row 6 into a rubber stamp.
 */

import fs from "node:fs";
import mysql from "mysql2/promise";
import { baselineFilePath, gateDatabaseUrl, GATE_DB_NAME } from "./state";

/** MySQL 8.4 default is 1024 — far too small for a whole-table stream. */
const GROUP_CONCAT_MAX_LEN = 1_073_741_824;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Business tables whose bytes must be identical before and after the matrix
 * (spec C7 row 6). The five `assistant_*` tables are the feature's own state and are
 * exempt WHOLESALE; `api_tokens` is digested with `lastUsedAt` excluded because the
 * MCP surface advances it as a fire-and-forget side effect of a READ.
 */
export const CHECKSUM_MANIFEST: string[] = [
  "ai_providers",
  "analytics_rebuild_runs",
  "analytics_rebuild_state",
  "api_tokens",
  "audit_logs",
  "bundle_components",
  "companies",
  "external_order_items",
  "external_orders",
  "fulfillment_observation_hints",
  "fulfillment_observations",
  "fulfillment_sync_state",
  "global_reorder_settings",
  "inbound_shipments",
  "integrations",
  "inventory_exceptions",
  "inventory_logs",
  "locations",
  "notification_history",
  "platform_write_attempts",
  "product_links",
  "product_locations",
  "product_reorder_configs",
  "product_sales_facts",
  "product_scratchpad_prices",
  "product_stock_snapshots",
  "products",
  "staging_items",
  "system_settings",
  "user_companies",
  "users",
  "webhook_deliveries",
];

export const CHECKSUM_EXEMPT: { table: string; columns?: string[] }[] = [
  { table: "assistant_threads" },
  { table: "assistant_messages" },
  { table: "assistant_requests" },
  { table: "assistant_runs" },
  { table: "assistant_eval_reports" },
  { table: "api_tokens", columns: ["lastUsedAt"] },
];

/** Column exclusions applied when digesting a manifest table. */
export function exemptColumnsFor(table: string): string[] {
  const entry = CHECKSUM_EXEMPT.find((row) => row.table === table && row.columns !== undefined);
  return entry?.columns ?? [];
}

export type TableDigests = Record<string, string>;

async function connect(): Promise<mysql.Connection> {
  const connection = await mysql.createConnection({
    uri: gateDatabaseUrl(),
    // The digest reads raw bytes; date strings must not be re-shaped by the driver.
    dateStrings: true,
    multipleStatements: false,
  });
  await connection.query(`SET SESSION group_concat_max_len = ${GROUP_CONCAT_MAX_LEN}`);
  return connection;
}

/** Run `fn` against a fresh gate connection and always close it (an open pool would
 *  hold a jest worker alive past the last assertion). */
export async function withOracleConnection<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const connection = await connect();
  try {
    return await fn(connection);
  } finally {
    await connection.end();
  }
}

/** Convenience for the matrices' recompute helpers: a parameterised read that never
 *  leaks a connection. */
export async function oracleQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withOracleConnection(async (conn) => {
    const [rows] = await conn.query(sql, params);
    return rows as T[];
  });
}

function assertIdentifier(kind: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`oracle refuses a non-allowlisted ${kind} identifier: ${JSON.stringify(value)}`);
  }
}

async function columnsOf(conn: mysql.Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [GATE_DB_NAME, table],
  );
  return (rows as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME);
}

async function primaryKeyOf(conn: mysql.Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query(
    "SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX",
    [GATE_DB_NAME, table],
  );
  return (rows as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME);
}

/**
 * `N:\N;` for NULL, `V<octetLen>:<bytes>;` otherwise — everything CAST to BINARY so
 * the concatenation has ONE collation and the octet length is measured on exactly
 * the bytes that get concatenated.
 */
function columnExpression(column: string): string {
  const quoted = `\`${column}\``;
  return (
    `CASE WHEN ${quoted} IS NULL THEN CAST('N:\\\\N;' AS BINARY) ELSE ` +
    `CONCAT(CAST('V' AS BINARY), CAST(OCTET_LENGTH(CAST(${quoted} AS BINARY)) AS BINARY), ` +
    `CAST(':' AS BINARY), CAST(${quoted} AS BINARY), CAST(';' AS BINARY)) END`
  );
}

function rowExpression(columns: string[]): string {
  return `CONCAT(${columns.map(columnExpression).join(", ")})`;
}

async function assertNoTruncation(conn: mysql.Connection, table: string): Promise<void> {
  const [warnings] = await conn.query("SHOW WARNINGS");
  const rows = warnings as Array<{ Level: string; Code: number; Message: string }>;
  if (rows.length > 0) {
    throw new Error(
      `oracle digest of ${table} produced warnings (a truncated GROUP_CONCAT would be a silent ` +
        `false PASS): ${rows.map((row) => `${row.Code} ${row.Message}`).join(" | ")}`,
    );
  }
}

/**
 * Total, collision-free digest of one table. `opts.excludeColumns` drops columns
 * from the encoding entirely (the `api_tokens.lastUsedAt` gate exemption).
 */
export async function tableDigest(
  table: string,
  opts?: { excludeColumns?: string[] },
): Promise<string> {
  assertIdentifier("table", table);
  for (const column of opts?.excludeColumns ?? []) assertIdentifier("column", column);

  return withOracleConnection(async (conn) => {
    const allColumns = await columnsOf(conn, table);
    if (allColumns.length === 0) {
      throw new Error(`oracle refuses ${table}: it has no columns in ${GATE_DB_NAME}`);
    }
    const excluded = new Set(opts?.excludeColumns ?? []);
    for (const column of opts?.excludeColumns ?? []) {
      if (!allColumns.includes(column)) {
        throw new Error(`oracle refuses ${table}: excluded column ${column} does not exist`);
      }
    }
    const columns = allColumns.filter((column) => !excluded.has(column));
    if (columns.length === 0) {
      throw new Error(`oracle refuses ${table}: every column is excluded`);
    }
    for (const column of columns) assertIdentifier("column", column);

    const pk = await primaryKeyOf(conn, table);
    if (pk.length === 0) {
      throw new Error(`oracle refuses ${table}: no PRIMARY KEY, so no deterministic row order`);
    }
    for (const column of pk) assertIdentifier("column", column);

    const rowExpr = rowExpression(columns);
    const order = pk.map((column) => `\`${column}\``).join(", ");

    // Fail BEFORE digesting if the stream cannot fit: a truncated GROUP_CONCAT is a
    // warning, and a warning-blind digest is a rubber stamp.
    const [limits] = await conn.query(
      "SELECT LEAST(@@session.group_concat_max_len, @@global.max_allowed_packet) AS cap",
    );
    const cap = Number((limits as Array<{ cap: number | string }>)[0].cap);
    const [sizes] = await conn.query(
      `SELECT COALESCE(SUM(OCTET_LENGTH(${rowExpr})), 0) AS bytes FROM \`${table}\``,
    );
    const bytes = Number((sizes as Array<{ bytes: number | string }>)[0].bytes);
    if (bytes > cap) {
      throw new Error(
        `oracle refuses ${table}: the encoded stream is ${bytes} bytes, over the ${cap}-byte ` +
          "GROUP_CONCAT / max_allowed_packet ceiling",
      );
    }

    const [rows] = await conn.query(
      `SELECT MD5(COALESCE(GROUP_CONCAT(${rowExpr} ORDER BY ${order} SEPARATOR ''), '')) AS digest FROM \`${table}\``,
    );
    await assertNoTruncation(conn, table);
    const digest = (rows as Array<{ digest: string | null }>)[0].digest;
    if (typeof digest !== "string") {
      throw new Error(`oracle digest of ${table} returned no value`);
    }
    return digest;
  });
}

/** Digest every manifest table, honouring the per-table column exemptions. */
export async function manifestDigests(): Promise<TableDigests> {
  const digests: TableDigests = {};
  for (const table of CHECKSUM_MANIFEST) {
    const excludeColumns = exemptColumnsFor(table);
    digests[table] = await tableDigest(
      table,
      excludeColumns.length > 0 ? { excludeColumns } : undefined,
    );
  }
  return digests;
}

/** The FULL-column api_tokens digest, so the bracket can state positively that
 *  `lastUsedAt` is the only column that moved (spec C7 row 6). */
export async function apiTokensFullDigest(): Promise<string> {
  return tableDigest("api_tokens");
}

export type ChecksumBaseline = { manifest: TableDigests; apiTokensFull: string; capturedAt: string };

/**
 * The D8 bracket's OPENING half. Written to a sidecar file beside the state file
 * because globalSetup's module state does not survive into globalTeardown; the
 * closing half reads it back and unlinks it.
 */
export async function captureChecksumBaseline(): Promise<ChecksumBaseline> {
  const baseline: ChecksumBaseline = {
    manifest: await manifestDigests(),
    apiTokensFull: await apiTokensFullDigest(),
    capturedAt: new Date().toISOString(),
  };
  fs.writeFileSync(baselineFilePath(), JSON.stringify(baseline, null, 2), { mode: 0o600 });
  return baseline;
}

export function readChecksumBaseline(): ChecksumBaseline {
  return JSON.parse(fs.readFileSync(baselineFilePath(), "utf8")) as ChecksumBaseline;
}

export type ChecksumComparison = {
  changedTables: string[];
  apiTokensLastUsedAtAdvanced: boolean;
};

export function compareDigests(
  before: TableDigests,
  after: TableDigests,
  apiTokensFullBefore: string,
  apiTokensFullAfter: string,
): ChecksumComparison {
  const changedTables = CHECKSUM_MANIFEST.filter((table) => before[table] !== after[table]);
  return {
    changedTables,
    apiTokensLastUsedAtAdvanced: apiTokensFullBefore !== apiTokensFullAfter,
  };
}
