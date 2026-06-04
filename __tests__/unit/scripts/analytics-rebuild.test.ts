// @jest-environment node
//
// Light unit test for the self-hosted scheduled entrypoint's PURE pieces:
// argv parsing + job routing. The libs are mocked so nothing touches the DB and
// the script's top-level `@/` imports resolve under jest's moduleNameMapper.
jest.mock("@/lib/analytics/rebuild-snapshots", () => ({
  rebuildStockSnapshots: jest.fn(() => Promise.resolve({ rowsInserted: 0, flaggedPairs: 0 })),
}));
jest.mock("@/lib/analytics/rebuild-sales", () => ({
  rebuildSalesFacts: jest.fn(() => Promise.resolve({ rowsDeleted: 0, rowsInserted: 0, unattributed: 0 })),
}));

import { parseArgs, runJob } from "@/scripts/analytics-rebuild";
import { rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";

const snapshotsMock = rebuildStockSnapshots as jest.Mock;
const salesMock = rebuildSalesFacts as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("parseArgs", () => {
  test("defaults: job=sales, mode=nightly when nothing passed", () => {
    expect(parseArgs([])).toEqual({ job: "sales", mode: "nightly", from: undefined, to: undefined });
  });

  test("reads job, mode, from, to", () => {
    expect(
      parseArgs(["--job", "snapshots", "--mode", "backfill", "--from", "2026-01-01", "--to", "2026-01-31"])
    ).toEqual({ job: "snapshots", mode: "backfill", from: "2026-01-01", to: "2026-01-31" });
  });

  test("unknown job falls back to sales; unknown mode falls back to nightly", () => {
    expect(parseArgs(["--job", "bogus", "--mode", "weird"])).toMatchObject({ job: "sales", mode: "nightly" });
  });
});

describe("runJob routing", () => {
  test("snapshots passes the from/to window through", async () => {
    await runJob({ job: "snapshots", mode: "backfill", from: "2026-01-01", to: "2026-01-31" });
    expect(snapshotsMock).toHaveBeenCalledWith({ from: "2026-01-01", to: "2026-01-31" });
    expect(salesMock).not.toHaveBeenCalled();
  });

  test("sales full => { full: true }", async () => {
    await runJob({ job: "sales", mode: "full" });
    expect(salesMock).toHaveBeenCalledWith({ full: true });
  });

  test("sales with --from => since = start of that UTC day", async () => {
    await runJob({ job: "sales", mode: "nightly", from: "2026-02-15" });
    expect(salesMock).toHaveBeenCalledWith({ since: new Date("2026-02-15T00:00:00Z") });
  });

  test("sales nightly (no from) => {} (lib default ~36h window)", async () => {
    await runJob({ job: "sales", mode: "nightly" });
    expect(salesMock).toHaveBeenCalledWith({});
  });
});
