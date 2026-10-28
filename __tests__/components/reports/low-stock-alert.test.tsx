/** @jest-environment jsdom */
/**
 * THE REPORTS PAGE'S LOW-STOCK CARD (A2 pack C5, A2-G1R3-15; seam S12).
 *
 * The card is NOT edited by A2 — what changed is the number it is handed. The low-stock
 * report used to round the usage rate to 1 decimal, so a slow mover (1 unit in 30 days =
 * 0.0333/day) arrived as 0: the card then said "Low usage" instead of a days-left figure
 * and dropped the usage line entirely (review #4's 0.0/day misread). The report now uses
 * the shared rate() (3 significant figures below 1), so the same product arrives as
 * 0.0333/day with floor(5 / 0.0333) = 150 days left, and the card shows both.
 *
 * The alert fed to the card here is the report module's REAL output for that product
 * (prisma mocked) — so this pin fails if the module's rounding regresses, not only if the
 * card's markup does.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/lib/prisma", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import prisma from "@/lib/prisma";
import { getLowStockReport } from "@/lib/reports/low-stock";
import { LowStockAlert } from "@/components/reports/low-stock-alert";
import type { LowStockAlert as LowStockAlertRow } from "@/types/reports";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;
const mockFetch = jest.fn();
const DAY = 86_400_000;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

/** The report's real alert for a product at `stock` with the given outbound history. */
async function alertFromReport(stock: number, outbound: Array<{ delta: number; daysAgo: number }>) {
  const now = Date.now();
  db.product.findMany.mockResolvedValue([
    { id: 1, name: "Slow Mover 5 mg", lowStockThreshold: 10, product_locations: [{ quantity: stock }] },
  ]);
  db.systemSetting.findUnique.mockResolvedValue(null);
  db.inventory_logs.findMany.mockResolvedValue(
    outbound.map((o) => ({
      productId: 1,
      delta: o.delta,
      changeTime: new Date(now - o.daysAgo * DAY),
      logType: "SALE",
      reasonCode: null,
    })),
  );
  const report = await getLowStockReport({});
  return report.alerts[0];
}

function renderCard(alerts: LowStockAlertRow[]) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ alerts }),
  } as unknown as Response);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LowStockAlert />
    </QueryClientProvider>,
  );
}

describe("a slow mover's real usage and days left (A2 C5)", () => {
  it("1 unit over 30 days at stock 5 shows 0.0333 units a day and 150 days left", async () => {
    // Day 30 exactly: days covered = 30, so the raw rate is 1/30 = 0.0333...
    const alert = await alertFromReport(5, [{ delta: -1, daysAgo: 30 }]);
    expect(alert.averageDailyUsage).toBe(0.0333);
    expect(alert.daysUntilEmpty).toBe(150);

    renderCard([alert]);
    expect(await screen.findByText("Average daily usage: 0.0333 units")).toBeInTheDocument();
    expect(screen.getByText("150 days left")).toBeInTheDocument();
    expect(screen.queryByText("Low usage")).not.toBeInTheDocument();
  });

  it("the shape the 1-decimal rounding produced (0/day, no days left) is what read 'Low usage'", async () => {
    // The contrast the change removes, rendered from the OLD figures for the same product.
    const alert = await alertFromReport(5, [{ delta: -1, daysAgo: 30 }]);
    renderCard([{ ...alert, averageDailyUsage: 0, daysUntilEmpty: null }]);
    expect(await screen.findByText("Low usage")).toBeInTheDocument();
    expect(screen.queryByText(/Average daily usage/)).not.toBeInTheDocument();
  });

  it("no measured outbound still reads unknown, never a fabricated rate", async () => {
    const alert = await alertFromReport(5, []);
    expect(alert.averageDailyUsage).toBeNull();
    renderCard([alert]);
    expect(await screen.findByText("Average daily usage: unknown")).toBeInTheDocument();
  });
});
