/**
 * @jest-environment node
 *
 * Trunk primitives `pageFromDb` and `byteBudget` (lib/assistant/tools.ts, spec D-T7):
 * DB-side paging where `count()` drives `totalRows` exactly, `fetch(skip, take)` pulls
 * one page, and the fetched page is byte-fit to the budget with a guaranteed >= 1 row
 * when the fetched page is non-empty. `nextOffset` covers BOTH row-count (limit) and
 * byte truncation, and is null once the page reaches the end.
 */

import { pageFromDb, byteBudget, PER_TOOL_RESULT_CAP_BYTES, type DbPage } from "@/lib/assistant/tools";
import type { ToolContext } from "@/lib/assistant/tools";

type Row = { id: number };

/** Mirrors the per-row byte accounting `pageFromDb` uses internally
 *  (`Buffer.byteLength(JSON.stringify(row ?? null), "utf8") + 1` for the comma),
 *  so tests can derive exact byte-budget thresholds instead of guessing. */
function rowBytes(row: unknown): number {
  return Buffer.byteLength(JSON.stringify(row ?? null), "utf8") + 1;
}

describe("pageFromDb (spec D-T7)", () => {
  it("count() drives totalRows exactly, independent of the fetched page length", async () => {
    const count = jest.fn().mockResolvedValue(7);
    const fetched: Row[] = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }];
    const fetch = jest.fn().mockResolvedValue(fetched);

    const page: DbPage<Row> = await pageFromDb({
      count,
      fetch,
      offset: 0,
      limit: 10,
      byteBudget: PER_TOOL_RESULT_CAP_BYTES,
    });

    expect(count).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(0, 10);
    expect(page.totalRows).toBe(7);
    expect(page.returned).toBe(4);
    expect(page.rows).toEqual(fetched);
    // more rows exist per totalRows even though the fetch itself was exhausted.
    expect(page.nextOffset).toBe(4);
  });

  it("offset >= totalRows clamps to the end: empty rows, returned 0, nextOffset null", async () => {
    const count = jest.fn().mockResolvedValue(7);
    const fetch = jest.fn().mockResolvedValue([]);

    const page = await pageFromDb({
      count,
      fetch,
      offset: 100,
      limit: 5,
      byteBudget: PER_TOOL_RESULT_CAP_BYTES,
    });

    // offset clamped to totalRows (7) before being handed to fetch as `skip`.
    expect(fetch).toHaveBeenCalledWith(7, 5);
    expect(page.totalRows).toBe(7);
    expect(page.rows).toEqual([]);
    expect(page.returned).toBe(0);
    expect(page.nextOffset).toBeNull();
  });

  it("byte-fit always returns >= 1 row, even when a single row exceeds the byte budget", async () => {
    const hugeRow: Row & { blob: string } = { id: 0, blob: "x".repeat(5_000) };
    const count = jest.fn().mockResolvedValue(1);
    const fetch = jest.fn().mockResolvedValue([hugeRow]);
    const tinyBudget = 50; // far smaller than a single serialized hugeRow

    expect(rowBytes(hugeRow)).toBeGreaterThan(tinyBudget);

    const page = await pageFromDb({
      count,
      fetch,
      offset: 0,
      limit: 5,
      byteBudget: tinyBudget,
    });

    expect(page.rows).toEqual([hugeRow]);
    expect(page.returned).toBe(1);
    expect(page.totalRows).toBe(1);
    expect(page.nextOffset).toBeNull(); // the lone row WAS the entire result set
  });

  it("nextOffset reflects row-truncation (limit < remaining rows)", async () => {
    const count = jest.fn().mockResolvedValue(10);
    const rows: Row[] = [{ id: 0 }, { id: 1 }, { id: 2 }]; // fetch honors take=3
    const fetch = jest.fn().mockResolvedValue(rows);

    const page = await pageFromDb({
      count,
      fetch,
      offset: 0,
      limit: 3,
      byteBudget: PER_TOOL_RESULT_CAP_BYTES, // generous — no byte truncation here
    });

    expect(fetch).toHaveBeenCalledWith(0, 3);
    expect(page.rows).toEqual(rows);
    expect(page.returned).toBe(3);
    expect(page.totalRows).toBe(10);
    // more rows exist beyond this limit-bound page.
    expect(page.nextOffset).toBe(3);
  });

  it("nextOffset reflects byte-truncation (byteBudget forces a shorter page than limit)", async () => {
    const rows: Row[] = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const count = jest.fn().mockResolvedValue(5);
    const fetch = jest.fn().mockResolvedValue(rows);

    // Each row serializes identically (single-digit id): compute a budget that fits
    // exactly the first two rows and no more, deterministically from rowBytes().
    const budget = 2 /* "[]" */ + rowBytes(rows[0]) + rowBytes(rows[1]);

    const page = await pageFromDb({
      count,
      fetch,
      offset: 0,
      limit: 5,
      byteBudget: budget,
    });

    expect(fetch).toHaveBeenCalledWith(0, 5);
    expect(page.rows).toEqual([rows[0], rows[1]]);
    expect(page.returned).toBe(2);
    expect(page.totalRows).toBe(5);
    // truncated by byte budget, not by limit — 3 rows remain unread.
    expect(page.nextOffset).toBe(2);
  });

  it("nextOffset is null once the fetched page reaches the end of totalRows", async () => {
    const rows: Row[] = [{ id: 0 }, { id: 1 }, { id: 2 }];
    const count = jest.fn().mockResolvedValue(3);
    const fetch = jest.fn().mockResolvedValue(rows);

    const page = await pageFromDb({
      count,
      fetch,
      offset: 0,
      limit: 5, // limit exceeds totalRows; fetch itself returns only what exists
      byteBudget: PER_TOOL_RESULT_CAP_BYTES,
    });

    expect(page.rows).toEqual(rows);
    expect(page.returned).toBe(3);
    expect(page.totalRows).toBe(3);
    expect(page.nextOffset).toBeNull();
  });
});

describe("byteBudget (spec D-T7)", () => {
  it("returns ctx.remainingBytes when it is BELOW the per-tool cap", () => {
    const ctx: ToolContext = { companyIds: [], remainingBytes: PER_TOOL_RESULT_CAP_BYTES - 1_000 };
    expect(byteBudget(ctx)).toBe(PER_TOOL_RESULT_CAP_BYTES - 1_000);
  });

  it("returns PER_TOOL_RESULT_CAP_BYTES when ctx.remainingBytes is ABOVE the cap", () => {
    const ctx: ToolContext = { companyIds: [], remainingBytes: PER_TOOL_RESULT_CAP_BYTES + 5_000 };
    expect(byteBudget(ctx)).toBe(PER_TOOL_RESULT_CAP_BYTES);
  });
});
