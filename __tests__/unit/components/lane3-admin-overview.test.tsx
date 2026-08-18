/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 6 (Lane W2-D) — the triage-first admin Overview ops-health section
 * (spec §11 D-L1/D-L4): verdict strip, needs-attention list, per-card degrade,
 * and the rebuild Run-now 4-state machine (idle -> confirm naming window/mode ->
 * running -> success/failure toast).
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpsHealthResponse } from "@/hooks/use-admin";

const infoToast = jest.fn();
const successToast = jest.fn();
const errorToast = jest.fn();
jest.mock("sonner", () => ({ toast: { info: (...a: any) => infoToast(...a), success: (...a: any) => successToast(...a), error: (...a: any) => errorToast(...a) } }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...p }: any) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

const useOpsHealthMock = jest.fn();
const mutateAsync = jest.fn().mockResolvedValue({});
jest.mock("@/hooks/use-admin", () => ({
  useOpsHealth: () => useOpsHealthMock(),
  useTriggerRebuild: () => ({ mutateAsync }),
  // Lane 6: the platform-writes tile uses the emergency-stop mutation.
  useSetPlatformWriteKillSwitch: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

import { OpsHealthSection } from "@/components/admin/ops-health-section";

function makeData(overrides: Partial<OpsHealthResponse> = {}): OpsHealthResponse {
  const nowIso = new Date().toISOString();
  return {
    verdict: "ok",
    attention: [],
    integrations: { status: "ok", data: [] },
    backups: { status: "ok", data: { newest: { name: "b.sql", mtimeMs: Date.now(), ageHours: 1 }, count: 1, volume: "ok" } },
    pendingReviews: { status: "ok", data: { pendingUsers: 0, pendingProducts: 0, stagingOpenNewFlow: 0, stagingResidualReceived: 0 } },
    rebuild: {
      status: "ok",
      data: {
        jobs: [{ job: "sales", enabled: true, lastSuccessAt: nowIso, lastError: null, lockHeld: false, lockStale: false, sidecarSeenAt: nowIso }],
        runs: [],
        sidecarSeenAt: nowIso,
        heartbeatStale: false,
      },
    },
    // Lane 6: the ops-health response gained a platform-writes posture block.
    platformWrites: {
      status: "ok",
      data: {
        effective: "off",
        capabilities: [],
        killSwitchEngaged: false,
        invalidEnv: false,
        invalidReasons: [],
        label: "Platform writes: OFF",
      },
    },
    ...overrides,
  };
}

function setData(data: OpsHealthResponse) {
  useOpsHealthMock.mockReturnValue({ data, isLoading: false, isError: false, refetch: jest.fn() });
}

beforeEach(() => jest.clearAllMocks());

test("loading => skeleton, no verdict strip yet", () => {
  useOpsHealthMock.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: jest.fn() });
  render(<OpsHealthSection />);
  expect(screen.queryByText(/System health/i)).toBeNull();
});

test("error => destructive box + Retry (section never silently vanishes)", () => {
  useOpsHealthMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: jest.fn() });
  render(<OpsHealthSection />);
  expect(screen.getByText(/Could not load system health/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
});

test("verdict 'ok' => positive all-clear strip", () => {
  setData(makeData());
  render(<OpsHealthSection />);
  expect(screen.getByText(/All systems healthy/i)).toBeInTheDocument();
});

test("needs-attention list renders actionable items with their system label + message", () => {
  setData(
    makeData({
      verdict: "failing",
      attention: [
        { severity: "negative", system: "Backups", message: "Backup volume unreadable", href: "/admin/backup" },
        { severity: "warning", system: "Reviews", message: "3 products awaiting review", href: "/admin/product-review" },
      ],
    }),
  );
  render(<OpsHealthSection />);
  expect(screen.getByText(/Action needed/i)).toBeInTheDocument();
  expect(screen.getByText("Backup volume unreadable")).toBeInTheDocument();
  expect(screen.getByText("3 products awaiting review")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Receiving/Labeling overhaul (PK2-12, spec §11): the pending-reviews card shows
// the staging work as TWO ROWS — live work on the new flow, and any residual
// legacy RECEIVED row, which is a cutover straggler rather than a queue. The two
// are NEVER added together, and the residual row never points at /pre-staging
// (M6 redirects it).
// ---------------------------------------------------------------------------

test("open new-flow lines render an INFORMATIONAL row, linked to /receiving (REV-10 clause 7)", () => {
  setData(
    makeData({
      pendingReviews: {
        status: "ok",
        data: { pendingUsers: 0, pendingProducts: 0, stagingOpenNewFlow: 5, stagingResidualReceived: 0 },
      },
    }),
  );
  render(<OpsHealthSection />);

  const row = screen.getByText(/Receiving lines in progress/i).closest("div")!;
  expect(row).toBeInTheDocument();
  expect(screen.getByText("5")).toBeInTheDocument();
  const link = screen.getAllByRole("link").find((a) => a.getAttribute("href") === "/receiving");
  expect(link).toBeDefined();
  expect(screen.queryByText(/awaiting graduation/i)).toBeNull();
  // The TONE is the finding: work in progress is NOT a warning. The residual
  // straggler row (below) still is.
  const badge = screen.getByText("5");
  expect(badge.className).toContain("bg-info-muted");
  expect(badge.className).not.toContain("bg-warning-muted");
});

test("live receiving work alone does NOT keep the section out of Clear (REV-10 clause 7)", () => {
  setData(
    makeData({
      pendingReviews: {
        status: "ok",
        data: { pendingUsers: 0, pendingProducts: 0, stagingOpenNewFlow: 5, stagingResidualReceived: 0 },
      },
    }),
  );
  render(<OpsHealthSection />);

  // Nothing is AWAITING REVIEW — somebody is simply working. Both statements
  // are true at once, and the panel makes both.
  expect(screen.getByText(/No items awaiting review/i)).toBeInTheDocument();
  expect(screen.getByText(/Receiving lines in progress/i)).toBeInTheDocument();
});

test("a residual RECEIVED row says legacy straggler + runbook, and links nowhere near /pre-staging", () => {
  setData(
    makeData({
      pendingReviews: {
        status: "ok",
        data: { pendingUsers: 0, pendingProducts: 0, stagingOpenNewFlow: 0, stagingResidualReceived: 2 },
      },
    }),
  );
  render(<OpsHealthSection />);

  expect(screen.getByText(/legacy straggler/i)).toBeInTheDocument();
  expect(screen.getByText(/receiving cutover runbook/i)).toBeInTheDocument();
  expect(
    screen.queryAllByRole("link").some((a) => a.getAttribute("href") === "/pre-staging"),
  ).toBe(false);
});

test("both staging counters render as TWO rows, never as one sum", () => {
  setData(
    makeData({
      pendingReviews: {
        status: "ok",
        data: { pendingUsers: 0, pendingProducts: 0, stagingOpenNewFlow: 5, stagingResidualReceived: 2 },
      },
    }),
  );
  render(<OpsHealthSection />);

  expect(screen.getByText("5")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
  // 7 would be the sum — it must appear nowhere.
  expect(screen.queryByText("7")).toBeNull();
});

test("all four counters at zero => the all-clear row", () => {
  setData(makeData());
  render(<OpsHealthSection />);
  expect(screen.getByText(/No items awaiting review/i)).toBeInTheDocument();
});

test("backup volume unreadable is a distinct labeled state (not 'none')", () => {
  setData(makeData({ backups: { status: "ok", data: { newest: null, count: 0, volume: "unavailable" } } }));
  render(<OpsHealthSection />);
  expect(screen.getByText(/Volume unreadable/i)).toBeInTheDocument();
});

test("per-card degrade: an unavailable subsystem shows its own degrade, other cards still render", () => {
  setData(makeData({ integrations: { status: "unavailable", errorCode: "INTEGRATIONS_UNAVAILABLE" } }));
  render(<OpsHealthSection />);
  expect(screen.getByText(/Integration health could not be read/i)).toBeInTheDocument();
  // The rest of the section is still present (scope to the section headings).
  expect(screen.getByRole("heading", { name: /Backups/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Analytics rebuild/i })).toBeInTheDocument();
});

test("Run-now 4-state: idle -> confirm names window/mode -> running fires trigger + 'Rebuild started'", async () => {
  const user = userEvent.setup();
  setData(makeData());
  render(<OpsHealthSection />);

  // idle
  const runBtn = screen.getByRole("button", { name: /Run rebuild/i });
  await user.click(runBtn);

  // confirm names both windows/modes
  const nightly = await screen.findByRole("button", { name: /Nightly \(recent window\)/i });
  expect(screen.getByRole("button", { name: /Full \(entire history\)/i })).toBeInTheDocument();

  await user.click(nightly);

  await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ job: "sales", mode: "nightly" }));
  expect(infoToast).toHaveBeenCalledWith("Rebuild started");
  await waitFor(() => expect(successToast).toHaveBeenCalled());
});

test("Run-now confirm can be cancelled without firing a rebuild", async () => {
  const user = userEvent.setup();
  setData(makeData());
  render(<OpsHealthSection />);

  await user.click(screen.getByRole("button", { name: /Run rebuild/i }));
  await user.click(await screen.findByRole("button", { name: /Cancel/i }));

  expect(screen.getByRole("button", { name: /Run rebuild/i })).toBeInTheDocument();
  expect(mutateAsync).not.toHaveBeenCalled();
});
