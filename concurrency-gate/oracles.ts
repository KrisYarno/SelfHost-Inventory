/**
 * concurrency-gate/oracles.ts — what the DATABASE says, computed WITHOUT the
 * code under test (plan P-2 "the units + money oracles"; pack C7a.1).
 *
 * `mysql2/promise` raw SQL only, deliberately: Prisma computes what the app
 * believes: this file computes what the rows actually contain. An oracle that
 * shared the primitive's code path would agree with it about a bug.
 *
 * THE THREE, run at the END of every scenario:
 *   unitsOracle    the ledger's STOCK_IN units for a line == the line's
 *                  stockedQuantity; the counters are non-negative and never
 *                  exceed what was verified.
 *   moneyOracle    the ledger's receipt shares for a line == the exact
 *                  cumulative share of the line total; an UNPRICED line has no
 *                  priced share at all; a SHORT ordered line's loss plus its
 *                  delivered value is the whole total.
 *   productOracle  `products.quantity` is the LOCATION-1 MIRROR (never the
 *                  global sum), on-hand across locations is what the scenario
 *                  expects, and — from this gate's zero baseline — equals the
 *                  sum of every ledger delta for the product.
 */

import mysql from "mysql2/promise";
import { gateDatabaseUrl } from "./state";

/** SUM()/DECIMAL come back as strings; ids and counts as numbers. One coercion
 *  at the boundary, so no assertion ever compares 7 with "7". */
function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`oracle read a non-numeric value: ${String(value)}`);
  return parsed;
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

async function withOracle<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const connection = await mysql.createConnection({
    uri: gateDatabaseUrl(),
    multipleStatements: false,
  });
  try {
    return await fn(connection);
  } finally {
    await connection.end();
  }
}

async function queryOne(
  conn: mysql.Connection,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown> | null> {
  const [rows] = await conn.query(sql, params);
  const list = rows as Record<string, unknown>[];
  return list[0] ?? null;
}

function report(name: string, failures: string[]): void {
  if (failures.length > 0) {
    throw new Error(`${name} FAILED:\n - ${failures.join("\n - ")}`);
  }
}

export type UnitsOracleResult = {
  stockedQuantity: number;
  disposedQuantity: number;
  verifiedQuantity: number | null;
  stockInUnits: number;
};

export async function unitsOracle(lineId: number): Promise<UnitsOracleResult> {
  const row = await withOracle((conn) =>
    queryOne(
      conn,
      `SELECT s.id,
              s.stockedQuantity,
              s.disposedQuantity,
              s.verifiedQuantity,
              COALESCE(SUM(CASE WHEN l.logType='STOCK_IN' THEN l.delta ELSE 0 END),0) AS stockInUnits
         FROM staging_items s
         LEFT JOIN inventory_logs l ON l.stagingItemId = s.id
        WHERE s.id = ?
        GROUP BY s.id`,
      [lineId],
    ),
  );
  if (!row) throw new Error(`unitsOracle(${lineId}): the line does not exist`);

  const result: UnitsOracleResult = {
    stockedQuantity: num(row.stockedQuantity),
    disposedQuantity: num(row.disposedQuantity),
    verifiedQuantity: nullableNum(row.verifiedQuantity),
    stockInUnits: num(row.stockInUnits),
  };

  const failures: string[] = [];
  if (result.stockInUnits !== result.stockedQuantity) {
    failures.push(
      `ledger STOCK_IN units ${result.stockInUnits} != stockedQuantity ${result.stockedQuantity}`,
    );
  }
  if (result.stockedQuantity < 0) failures.push(`stockedQuantity ${result.stockedQuantity} < 0`);
  if (result.disposedQuantity < 0) failures.push(`disposedQuantity ${result.disposedQuantity} < 0`);
  if (
    result.verifiedQuantity !== null &&
    result.stockedQuantity + result.disposedQuantity > result.verifiedQuantity
  ) {
    failures.push(
      `stocked ${result.stockedQuantity} + disposed ${result.disposedQuantity} exceeds verified ${result.verifiedQuantity}`,
    );
  }
  report(`unitsOracle(${lineId})`, failures);
  return result;
}

export type MoneyOracleResult = {
  lineTotalCents: number | null;
  stockedQuantity: number;
  receiptSum: number;
  expectedSum: number | null;
  pricedShares: number;
  stockInRows: number;
  lossCents: number | null;
};

export async function moneyOracle(lineId: number): Promise<MoneyOracleResult> {
  return withOracle(async (conn) => {
    const row = await queryOne(
      conn,
      `SELECT s.id,
              s.lineTotalCents,
              s.orderedQuantity,
              s.verifiedQuantity,
              s.stockedQuantity,
              COALESCE(SUM(CASE WHEN l.logType='STOCK_IN' THEN l.receiptCostCents END),0) AS receiptSum,
              COALESCE(SUM(CASE WHEN l.logType='STOCK_IN' AND l.receiptCostCents IS NOT NULL THEN 1 ELSE 0 END),0) AS pricedShares,
              COALESCE(SUM(CASE WHEN l.logType='STOCK_IN' THEN 1 ELSE 0 END),0) AS stockInRows,
              FLOOR(CAST(s.lineTotalCents AS DECIMAL(65,0)) * s.stockedQuantity / NULLIF(COALESCE(s.orderedQuantity, s.verifiedQuantity),0)) AS expectedSum
         FROM staging_items s
         LEFT JOIN inventory_logs l ON l.stagingItemId = s.id
        WHERE s.id = ?
        GROUP BY s.id`,
      [lineId],
    );
    if (!row) throw new Error(`moneyOracle(${lineId}): the line does not exist`);

    const lineTotalCents = nullableNum(row.lineTotalCents);
    const orderedQuantity = nullableNum(row.orderedQuantity);
    const verifiedQuantity = nullableNum(row.verifiedQuantity);
    const basis = orderedQuantity ?? verifiedQuantity;
    const failures: string[] = [];

    const result: MoneyOracleResult = {
      lineTotalCents,
      stockedQuantity: num(row.stockedQuantity),
      receiptSum: num(row.receiptSum),
      expectedSum: nullableNum(row.expectedSum),
      pricedShares: num(row.pricedShares),
      stockInRows: num(row.stockInRows),
      lossCents: null,
    };

    if (lineTotalCents !== null && basis !== null && basis > 0) {
      if (result.expectedSum === null) {
        failures.push("the expected cumulative share could not be computed");
      } else if (result.receiptSum !== result.expectedSum) {
        failures.push(
          `SUM(receiptCostCents) ${result.receiptSum} != cumulative(stocked) ${result.expectedSum}`,
        );
      }
    }
    if (lineTotalCents === null && result.pricedShares !== 0) {
      failures.push(
        `an unpriced line carries ${result.pricedShares} STOCK_IN row(s) with a non-null receiptCostCents`,
      );
    }

    // The SHORT-line settlement: what the supplier owes back plus what was
    // actually delivered is the whole line total, to the cent.
    const short = await queryOne(
      conn,
      `SELECT CAST(e.subject->>'$.lossCents' AS SIGNED) AS lossCents,
              s.lineTotalCents,
              FLOOR(CAST(s.lineTotalCents AS DECIMAL(65,0)) * s.verifiedQuantity / NULLIF(s.orderedQuantity,0)) AS deliveredValue
         FROM staging_items s
         JOIN inventory_exceptions e ON e.` + "`key`" + ` = CONCAT('recv-discrepancy:', s.id)
        WHERE s.id = ?`,
      [lineId],
    );
    if (
      short &&
      lineTotalCents !== null &&
      orderedQuantity !== null &&
      orderedQuantity > 0 &&
      verifiedQuantity !== null &&
      verifiedQuantity < orderedQuantity
    ) {
      const lossCents = num(short.lossCents);
      const deliveredValue = num(short.deliveredValue);
      result.lossCents = lossCents;
      if (lossCents + deliveredValue !== lineTotalCents) {
        failures.push(
          `lossCents ${lossCents} + delivered ${deliveredValue} != lineTotalCents ${lineTotalCents}`,
        );
      }
    }

    report(`moneyOracle(${lineId})`, failures);
    return result;
  });
}

export type ProductOracleResult = {
  compatQuantity: number;
  locationOneQuantity: number;
  onHand: number;
  ledgerSum: number;
};

export async function productOracle(
  productId: number,
  expectedOnHand: number,
): Promise<ProductOracleResult> {
  const row = await withOracle((conn) =>
    queryOne(
      conn,
      `SELECT p.quantity AS compatQuantity,
              COALESCE((SELECT pl.quantity FROM product_locations pl WHERE pl.productId = p.id AND pl.locationId = 1), 0) AS locationOneQuantity,
              COALESCE((SELECT SUM(pl.quantity) FROM product_locations pl WHERE pl.productId = p.id), 0) AS onHand,
              COALESCE((SELECT SUM(il.delta) FROM inventory_logs il WHERE il.productId = p.id), 0) AS ledgerSum
         FROM products p
        WHERE p.id = ?`,
      [productId],
    ),
  );
  if (!row) throw new Error(`productOracle(${productId}): the product does not exist`);

  const result: ProductOracleResult = {
    compatQuantity: num(row.compatQuantity),
    locationOneQuantity: num(row.locationOneQuantity),
    onHand: num(row.onHand),
    ledgerSum: num(row.ledgerSum),
  };

  const failures: string[] = [];
  if (result.compatQuantity !== result.locationOneQuantity) {
    failures.push(
      `products.quantity ${result.compatQuantity} != the LOCATION-1 quantity ${result.locationOneQuantity} (the compatibility mirror is location 1, never the global sum)`,
    );
  }
  if (result.onHand !== expectedOnHand) {
    failures.push(`SUM(product_locations.quantity) ${result.onHand} != expected ${expectedOnHand}`);
  }
  if (result.onHand !== result.ledgerSum) {
    failures.push(
      `SUM(product_locations.quantity) ${result.onHand} != SUM(inventory_logs.delta) ${result.ledgerSum}`,
    );
  }
  report(`productOracle(${productId})`, failures);
  return result;
}
