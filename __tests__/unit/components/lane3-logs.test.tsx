/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 4 (W2-B) — admin logs UI: batch drawer, audit feed rows, change
 * log handoff columns, transfer transferId affordance, review-dialog D11.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { actionMeta } from "@/lib/change-tracking/taxonomy";

// ---- module mocks (hoisted) ------------------------------------------------
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
jest.mock("next-auth/react", () => ({
  __esModule: true,
  useSession: jest.fn(),
}));
jest.mock("@/hooks/use-paginated-logs", () => ({
  __esModule: true,
  usePaginatedLogs: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

import { BatchDrawer } from "@/components/logs/batch-drawer";
import { AuditLogTab } from "@/components/logs/audit-log-tab";
import { ChangeLogTab } from "@/components/logs/change-log-tab";
import { TransferLogTable } from "@/components/inventory/transfer-log-table";
import { ReviewChangesDialog } from "@/components/journal/review-changes-dialog";
import { useSession } from "next-auth/react";
import { usePaginatedLogs } from "@/hooks/use-paginated-logs";

// jsdom polyfills for Radix Dialog / Select / pointer.
beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const BATCH_UUID = "11111111-1111-4111-8111-111111111111";

const batchResponse = {
  events: {
    items: [
      {
        id: 1,
        createdAt: "2026-07-10T10:00:00.000Z",
        actionType: "INVENTORY_ADJUSTMENT",
        meta: actionMeta("INVENTORY_ADJUSTMENT"),
        actorKind: "USER",
        actorName: "kris",
        action: "Adjusted stock",
        changes: { quantity: { from: 5, to: 8 } },
        entityType: "INVENTORY",
        entityId: "42",
        affectedCount: 1,
      },
    ],
    total: 1,
    limit: 25,
    offset: 0,
  },
  ledgerRows: {
    items: [
      {
        id: 9,
        changeTime: "2026-07-10T10:00:01.000Z",
        delta: 3,
        logType: "ADJUSTMENT",
        reasonCode: "DAMAGE",
        unitCostCents: 1234,
        productName: "BPC 5mg",
        locationName: "Main",
        transferId: null,
        userName: "kris",
      },
    ],
    total: 1,
    limit: 25,
    offset: 0,
  },
  // P2-B1.5b — the TOTAL summary, independent of the two section pages above.
  summary: {
    rowCount: 1,
    productCount: 1,
    netUnits: 3,
    logTypes: ["ADJUSTMENT"],
    actors: ["kris"],
    orders: [],
  },
};

function mockFetchBatch(resp: unknown = batchResponse, ok = true) {
  (global as any).fetch = jest.fn(async (url: string) => {
    if (String(url).includes("/api/admin/batch/")) {
      return { ok, json: async () => resp } as unknown as Response;
    }
    return { ok: false, json: async () => ({}) } as unknown as Response;
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// BatchDrawer
// ---------------------------------------------------------------------------

describe("BatchDrawer", () => {
  it("is closed (renders no dialog) when batchId is null", () => {
    renderWithClient(<BatchDrawer batchId={null} onOpenChange={jest.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("fetches and renders Events + Inventory movements sections for a batch", async () => {
    mockFetchBatch();
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Events")).toBeInTheDocument());
    expect(screen.getByText("Inventory movements")).toBeInTheDocument();
    // event diff + movement product surface.
    expect(screen.getByText("quantity")).toBeInTheDocument();
    expect(screen.getByText("BPC 5mg")).toBeInTheDocument();
    // counts in the sticky header.
    expect(screen.getByText(/1 event · 1 movement/)).toBeInTheDocument();
    // the request carried the paging params.
    expect((global as any).fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/admin/batch/${BATCH_UUID}?`)
    );
  });

  it("shows an empty state when the batch has no entries", async () => {
    mockFetchBatch({
      events: { items: [], total: 0, limit: 25, offset: 0 },
      ledgerRows: { items: [], total: 0, limit: 25, offset: 0 },
      summary: { rowCount: 0, productCount: 0, netUnits: 0, logTypes: [], actors: [], orders: [] },
    });
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/No entries in this batch/i)).toBeInTheDocument()
    );
  });

  it("shows an error state with Retry when the fetch fails", async () => {
    mockFetchBatch({}, false);
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument()
    );
  });

  it("copies the batch id to the clipboard from the sticky header", async () => {
    const user = userEvent.setup();
    mockFetchBatch();
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("Events")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /copy batch id/i }));
    // userEvent.setup() installs its own clipboard stub — read it back.
    expect(await navigator.clipboard.readText()).toBe(BATCH_UUID);
  });

  // -- P2-B1.5b: the header summary line ------------------------------------

  function withSummary(summary: Record<string, unknown>) {
    return {
      ...batchResponse,
      ledgerRows: { ...batchResponse.ledgerRows, total: summary.rowCount as number },
      summary,
    };
  }

  it("renders the whole-batch summary line under the counts", async () => {
    mockFetchBatch(
      withSummary({
        rowCount: 4,
        productCount: 2,
        netUnits: -4,
        logTypes: ["SALE"],
        actors: ["derek"],
        orders: [{ id: "ord_1", orderNumber: "23716" }],
      })
    );
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText("Sale · 2 products · -4 units · derek · order #23716")
      ).toBeInTheDocument()
    );
  });

  it("omits the order segment entirely (no trailing separator) when nothing is stamped", async () => {
    mockFetchBatch(
      withSummary({
        rowCount: 3,
        productCount: 3,
        netUnits: 6,
        logTypes: ["COUNT"],
        actors: ["derek", "kris"],
        orders: [],
      })
    );
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    const line = await screen.findByText(/3 products/);
    expect(line).toHaveTextContent("Count · 3 products · +6 units · derek, kris");
    expect(line.textContent).not.toMatch(/·\s*$/);
    expect(line.textContent).not.toMatch(/order/);
  });

  it("G2s-9: a summary missing an array renders without it, instead of taking the drawer down", async () => {
    // A version-skewed body: `orders` never arrived. The caller's `data?.summary`
    // belt lets it through, so the guard has to live one level deeper — an
    // unguarded `.map` here would throw in render and blank the whole drawer.
    mockFetchBatch(
      withSummary({
        rowCount: 2,
        productCount: 1,
        netUnits: -2,
        logTypes: ["SALE"],
        actors: ["derek"],
      })
    );
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    const line = await screen.findByText(/1 product/);
    expect(line).toHaveTextContent("Sale · 1 product · -2 units · derek");
    expect(line.textContent).not.toMatch(/order/);
  });

  it("FD1-8: an empty always-present segment leaves no dangling separator", async () => {
    // `logTypes` empty (a batch whose rows carry no log type the API could
    // name) used to render as an empty first segment — the line opened with
    // " · 1 product". Same for an actorless batch in the middle of the line.
    mockFetchBatch(
      withSummary({
        rowCount: 2,
        productCount: 1,
        netUnits: -2,
        logTypes: [],
        actors: [],
        orders: [{ id: "ord_1", orderNumber: "23716" }],
      })
    );
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    const line = await screen.findByText(/1 product/);
    expect(line).toHaveTextContent("1 product · -2 units · order #23716");
    expect(line.textContent).not.toMatch(/^\s*·/);
    expect(line.textContent).not.toMatch(/·\s*·/);
  });

  it("FD2-4: a summary missing its NUMBERS renders without spelling \"undefined\"", async () => {
    // The three arrays got the version-skew belt; the two NUMBERS did not, so a
    // body that carried neither rendered "undefined products · undefined units"
    // — a line an operator reads as data. A missing number has no segment.
    mockFetchBatch(
      withSummary({
        rowCount: 2,
        logTypes: ["SALE"],
        actors: ["derek"],
        orders: [{ id: "ord_1", orderNumber: "23716" }],
      })
    );
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    const line = await screen.findByText(/order #23716/);
    expect(line).toHaveTextContent("Sale · derek · order #23716");
    expect(line.textContent).not.toMatch(/undefined/);
  });

  it("QA-4: a NaN-shaped count renders no segment (the guard is isFinite, not typeof)", async () => {
    // `typeof NaN === "number"`, so the earlier shape of the FD2-4 belt let a
    // NaN through and the line read "NaN products" — the same "a number an
    // operator reads as data" the belt exists to stop, one shape along. The
    // fetch stub answers with the object as-is, which is how a client-side
    // computed count (a subtraction over a missing field) actually arrives.
    mockFetchBatch(
      withSummary({
        rowCount: 2,
        productCount: NaN,
        netUnits: -2,
        logTypes: ["SALE"],
        actors: ["derek"],
        orders: [{ id: "ord_1", orderNumber: "23716" }],
      })
    );
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    const line = await screen.findByText(/order #23716/);
    expect(line).toHaveTextContent("Sale · -2 units · derek · order #23716");
    expect(line.textContent).not.toMatch(/NaN/);
    expect(line.textContent).not.toMatch(/products?/);
  });

  it("hides the summary line entirely for an events-only batch (rowCount 0)", async () => {
    mockFetchBatch({
      ...batchResponse,
      ledgerRows: { items: [], total: 0, limit: 25, offset: 0 },
      summary: { rowCount: 0, productCount: 0, netUnits: 0, logTypes: [], actors: [], orders: [] },
    });
    renderWithClient(<BatchDrawer batchId={BATCH_UUID} onOpenChange={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Events")).toBeInTheDocument());
    expect(screen.queryByText(/products?/)).not.toBeInTheDocument();
    expect(screen.queryByText(/units/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AuditLogTab — batch chip -> drawer, ip/userAgent demotion
// ---------------------------------------------------------------------------

const auditLog = {
  id: 1,
  userId: 7,
  actorKind: "USER",
  actionType: "INVENTORY_ADJUSTMENT",
  entityType: "INVENTORY",
  entityId: "42",
  batchId: BATCH_UUID,
  action: "Adjusted stock",
  details: { changes: { quantity: { from: 5, to: 8 } } },
  ipAddress: "203.0.113.9",
  userAgent: "jest-agent/1.0",
  affectedCount: 1,
  createdAt: "2026-07-10T10:00:00.000Z",
  user: { id: 7, username: "kris", email: "kris@example.com" },
};

function mockAuditData() {
  (useSession as jest.Mock).mockReturnValue({
    data: { user: { isAdmin: true } },
    status: "authenticated",
  });
  (usePaginatedLogs as jest.Mock).mockReturnValue({
    data: { logs: [auditLog], total: 1 },
    isLoading: false,
    isRefreshing: false,
    error: null,
    refresh: jest.fn(),
  });
}

describe("AuditLogTab", () => {
  it("demotes ipAddress into the expand body (not shown collapsed, shown after toggle)", async () => {
    const user = userEvent.setup();
    mockAuditData();
    renderWithClient(<AuditLogTab active />);

    // ip is NOT visible in the collapsed rows.
    expect(screen.queryByText("203.0.113.9")).not.toBeInTheDocument();

    // Expand the desktop row's request-details disclosure.
    const toggle = screen.getAllByRole("button", { name: /toggle request details/i })[0];
    await user.click(toggle);
    expect(screen.getAllByText("203.0.113.9").length).toBeGreaterThan(0);
  });

  it("promotes the headline field change to the row (renders the diff)", () => {
    mockAuditData();
    renderWithClient(<AuditLogTab active />);
    expect(screen.getAllByText("quantity").length).toBeGreaterThan(0);
    expect(screen.getAllByText("→").length).toBeGreaterThan(0);
  });

  it("opens the batch drawer when a row's batch chip is clicked", async () => {
    const user = userEvent.setup();
    mockAuditData();
    mockFetchBatch();
    renderWithClient(<AuditLogTab active />);

    const chip = screen.getAllByRole("button", { name: /view batch/i })[0];
    await user.click(chip);

    await waitFor(() => expect(screen.getByText("Inventory movements")).toBeInTheDocument());
    expect((global as any).fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/admin/batch/${BATCH_UUID}?`)
    );
  });
});

// ---------------------------------------------------------------------------
// ChangeLogTab — the batch chip carries the batch's row count (P2-B1.5b)
// ---------------------------------------------------------------------------

describe("ChangeLogTab batch chip", () => {
  const inventoryLog = {
    id: 9,
    timestamp: "2026-07-10T10:00:01.000Z",
    productName: "BPC 5mg",
    userName: "derek",
    locationName: "Main",
    delta: -1,
    logType: "SALE",
    reasonCode: null,
    unitCostCents: null,
    batchId: BATCH_UUID,
    batchRowCount: 4 as number | null,
  };

  function mockLogsPage(over: Partial<typeof inventoryLog> = {}) {
    // The filters query is a plain fetch; let it fail harmlessly.
    (global as any).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
    (usePaginatedLogs as jest.Mock).mockReturnValue({
      data: { logs: [{ ...inventoryLog, ...over }], total: 1, page: 1, pageSize: 20, totalPages: 1 },
      isLoading: false,
      isRefreshing: false,
      error: null,
      refresh: jest.fn(),
    });
  }

  it("renders 'Batch · 4' and the counted aria-label on BOTH the mobile card and the desktop cell", async () => {
    mockLogsPage();
    renderWithClient(<ChangeLogTab active />);

    const chips = await screen.findAllByRole("button", { name: "View batch (4 rows)" });
    expect(chips).toHaveLength(2);
    chips.forEach((chip) => expect(chip).toHaveTextContent("Batch · 4"));
  });

  it("falls back to a bare 'Batch' chip when the row carries no count", async () => {
    mockLogsPage({ batchRowCount: null });
    renderWithClient(<ChangeLogTab active />);

    const chips = await screen.findAllByRole("button", { name: "View batch" });
    expect(chips).toHaveLength(2);
    chips.forEach((chip) => expect(chip).toHaveTextContent(/^Batch$/));
    expect(screen.queryByText(/Batch ·/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TransferLogTable — transferId column + copy affordance + arrow glyph
// ---------------------------------------------------------------------------

describe("TransferLogTable", () => {
  const row = {
    id: 1,
    createdAt: "2026-07-10T10:00:00.000Z",
    productName: "BPC 5mg",
    quantity: 4,
    fromLocationName: "Warehouse",
    toLocationName: "Store",
    userName: "kris",
    batchId: BATCH_UUID,
    transferId: "abcdef01-2345-4111-8111-222222222222",
  };

  it("renders a transferId with a copy affordance and copies the full id", async () => {
    const user = userEvent.setup();
    render(<TransferLogTable logs={[row]} />);

    const copyButtons = screen.getAllByRole("button", { name: /copy transfer id/i });
    expect(copyButtons.length).toBeGreaterThan(0);
    await user.click(copyButtons[0]);
    expect(await navigator.clipboard.readText()).toBe(row.transferId);
  });

  it("uses the → glyph for the from→to rendering", () => {
    render(<TransferLogTable logs={[row]} />);
    expect(screen.getAllByText("→").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ReviewChangesDialog — D11 a11y + zero-change
// ---------------------------------------------------------------------------

describe("ReviewChangesDialog (D11)", () => {
  const products = [
    { id: 1, name: "A", currentQuantity: 10 },
    { id: 2, name: "B", currentQuantity: 10 },
    { id: 3, name: "C", currentQuantity: 1 },
  ] as never;

  const adjustments = {
    1: { productId: 1, quantityChange: 5 },
    2: { productId: 2, quantityChange: 0 },
    3: { productId: 3, quantityChange: -3 },
  } as never;

  it("renders exactly ONE role=alert (the banner only; per-row badges lose the role)", () => {
    render(
      <ReviewChangesDialog
        open
        onOpenChange={jest.fn()}
        adjustments={adjustments}
        products={products}
        onConfirm={jest.fn()}
      />
    );
    // Product C (1 + -3 = -2) triggers the negative-stock banner.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("renders a 0-change row as a neutral 'No change' (no sign coloring)", () => {
    render(
      <ReviewChangesDialog
        open
        onOpenChange={jest.fn()}
        adjustments={adjustments}
        products={products}
        onConfirm={jest.fn()}
      />
    );
    expect(screen.getByText("No change")).toBeInTheDocument();
    // net includes the 0 (5 + 0 - 3 = +2).
    expect(screen.getByText("+2")).toBeInTheDocument();
  });
});
