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
