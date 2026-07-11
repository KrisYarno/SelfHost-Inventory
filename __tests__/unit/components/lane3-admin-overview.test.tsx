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
}));

import { OpsHealthSection } from "@/components/admin/ops-health-section";

function makeData(overrides: Partial<OpsHealthResponse> = {}): OpsHealthResponse {
  const nowIso = new Date().toISOString();
  return {
    verdict: "ok",
    attention: [],
    integrations: { status: "ok", data: [] },
    backups: { status: "ok", data: { newest: { name: "b.sql", mtimeMs: Date.now(), ageHours: 1 }, count: 1, volume: "ok" } },
    pendingReviews: { status: "ok", data: { pendingUsers: 0, pendingProducts: 0, stagingReceived: 0 } },
    rebuild: {
      status: "ok",
      data: {
        jobs: [{ job: "sales", enabled: true, lastSuccessAt: nowIso, lastError: null, lockHeld: false, lockStale: false, sidecarSeenAt: nowIso }],
        runs: [],
        sidecarSeenAt: nowIso,
        heartbeatStale: false,
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
