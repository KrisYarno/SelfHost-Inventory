/** @jest-environment jsdom */
//
// Task 3.1 — the admin assistant usage page (spec C8; contract pack T11, seam S19).
//
// Two halves:
//   1. the presentation pieces in isolation — the rollup table (per-user/day with the
//      model + kind breakdown), the tool-mix panel, and the incomplete-requests
//      disclosure;
//   2. `AdminUsagePage` — range picker default, loading/error states, the C9 eval
//      MOUNT POINT (Task 3.2 owns the section itself), and the two standing
//      prohibitions: NO dollar estimates and NO private thread content.
//
// The truthful-data north star is the thing most of these assertions defend: a NULL
// token column is "not reported", never 0; a rollup over zero rows is a named reason,
// never a zero-filled table.

import * as React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The hook module keeps its real constants/helpers; only the query is stubbed.
let mockUsageQuery: any;
jest.mock("@/hooks/use-assistant-usage", () => {
  const actual = jest.requireActual("@/hooks/use-assistant-usage");
  return {
    __esModule: true,
    ...actual,
    useAssistantUsage: (...args: unknown[]) => {
      mockUsageCalls.push(args[0]);
      return mockUsageQuery;
    },
  };
});
const mockUsageCalls: any[] = [];

// Task 3.2 (shared-file rule): the page now mounts the C9 eval section, whose own
// query is exercised in assistant-eval-report.test.tsx. Stubbed to its EMPTY state
// here so these C8 assertions keep testing the usage page, not the eval fetch.
jest.mock("@/hooks/use-assistant-eval", () => {
  const actual = jest.requireActual("@/hooks/use-assistant-eval");
  return {
    __esModule: true,
    ...actual,
    useAssistantEvalReports: () => ({
      data: { latest: null, history: [], historyNote: "the 50 most recent reports" },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    }),
  };
});

import {
  USAGE_DEFINITIONS,
  TOOL_MIX_DEFINITION,
  TOKENS_ONLY_NOTE,
  PRIVACY_NOTE,
  NOT_REPORTED_LABEL,
  EMPTY_ROLLUP_REASON,
  EMPTY_TOOL_MIX_REASON,
  EVAL_SECTION_MOUNT_ID,
} from "@/components/admin/usage/usage-definitions";
import { TokenRollupTable } from "@/components/admin/usage/token-rollup-table";
import { ToolMixPanel } from "@/components/admin/usage/tool-mix-panel";
import { IncompleteRequestsDisclosure } from "@/components/admin/usage/incomplete-requests-disclosure";
import { UsageRangePicker } from "@/components/admin/usage/usage-range-picker";
import { EVAL_SECTION_HEADING } from "@/components/admin/usage/eval-section";
import AdminUsagePage from "@/app/(app)/admin/usage/page";
import {
  DEFAULT_RANGE_DAYS,
  rangeForDays,
  type AssistantUsageResponse,
  type AssistantUsageRollup,
} from "@/hooks/use-assistant-usage";

/* eslint-disable @typescript-eslint/no-explicit-any */

function rollup(overrides: Partial<AssistantUsageRollup> = {}): AssistantUsageRollup {
  return {
    userId: 7,
    displayName: "kris",
    dayKey: "2026-08-10",
    model: "claude-x",
    kind: "chat",
    requests: 3,
    inputTokens: 300,
    outputTokens: 90,
    totalTokens: 390,
    aborted: 0,
    errored: 0,
    running: 0,
    nullUsageRequests: 0,
    ...overrides,
  };
}

function usageData(overrides: Partial<AssistantUsageResponse> = {}): AssistantUsageResponse {
  return {
    range: { from: "2026-07-29", to: "2026-08-11" },
    tokenRollups: [rollup()],
    toolMix: [{ toolName: "get_stock", calls: 4 }],
    horizonNote: "newest 10,000 runs retained — window may be clipped",
    ...overrides,
  };
}

/** The whole page's visible prose — the surface both prohibitions are asserted over. */
function pageText(): string {
  return document.body.textContent ?? "";
}

/**
 * The page's prose MINUS the C9 eval section (task 3.2). Spec C8 is precise about
 * this: no PRIVATE thread content appears on this page, and the eval section —
 * admin-curated corpus prompts and USER-INITIATED reports — is the one explicit,
 * labelled exception. So the thread-content prohibition is asserted over everything
 * OUTSIDE the anchor; the section itself is governed by its own tests.
 */
function textOutsideEvalSection(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelector(`#${EVAL_SECTION_MOUNT_ID}`)?.remove();
  return clone.textContent ?? "";
}

beforeEach(() => {
  mockUsageCalls.length = 0;
  mockUsageQuery = { data: usageData(), isLoading: false, isError: false, refetch: jest.fn() };
});

// ---------------------------------------------------------------------------
// Rollup table
// ---------------------------------------------------------------------------

describe("TokenRollupTable", () => {
  it("renders one row per user/day/model/kind with its counts", () => {
    render(
      <TokenRollupTable
        rollups={[
          rollup({ kind: "chat", requests: 3, totalTokens: 390 }),
          rollup({ kind: "title", requests: 2, inputTokens: 16, outputTokens: 8, totalTokens: 24 }),
        ]}
      />,
    );

    const rows = screen.getAllByRole("row");
    // header + 2 data rows + totals row
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText("kris").length).toBe(2);
    expect(screen.getAllByText("2026-08-10").length).toBe(2);
    expect(screen.getByText("chat")).toBeInTheDocument();
    expect(screen.getByText("title")).toBeInTheDocument();
  });

  // A count of 0 aborted requests is a MEASURED zero and renders as 0; the north star
  // is about structurally-unpopulated values, which here are the three token columns.
  it("renders a NULL token column as the named reason, never as 0", () => {
    render(
      <TokenRollupTable
        rollups={[
          rollup({
            requests: 2,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            nullUsageRequests: 2,
            errored: 2,
          }),
        ]}
      />,
    );

    const row = screen.getAllByRole("row")[1];
    for (const column of ["inputTokens", "outputTokens", "totalTokens"]) {
      expect(within(row).getByTestId(`cell-${column}`)).toHaveTextContent(NOT_REPORTED_LABEL);
      expect(within(row).getByTestId(`cell-${column}`)).not.toHaveTextContent("0");
    }
    expect(within(row).getAllByText(NOT_REPORTED_LABEL).length).toBe(3);
  });

  it("displays nullUsageRequests as its own column", () => {
    render(<TokenRollupTable rollups={[rollup({ requests: 5, nullUsageRequests: 2 })]} />);

    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("cell-nullUsageRequests")).toHaveTextContent("2");
  });

  it("carries a definition string for EVERY aggregate it shows", () => {
    render(<TokenRollupTable rollups={[rollup()]} />);

    for (const definition of Object.values(USAGE_DEFINITIONS)) {
      expect(screen.getByText(definition)).toBeInTheDocument();
    }
  });

  it("totals the columns null-preservingly — an all-null column totals to the reason, not 0", () => {
    render(
      <TokenRollupTable
        rollups={[
          rollup({ requests: 1, inputTokens: null, outputTokens: null, totalTokens: null, nullUsageRequests: 1 }),
          rollup({ dayKey: "2026-08-09", requests: 2, inputTokens: null, outputTokens: null, totalTokens: null, nullUsageRequests: 2 }),
        ]}
      />,
    );

    const totals = screen.getByTestId("rollup-totals");
    expect(within(totals).getByTestId("cell-requests")).toHaveTextContent("3");
    expect(within(totals).getByTestId("cell-nullUsageRequests")).toHaveTextContent("3");
    expect(within(totals).getAllByText(NOT_REPORTED_LABEL).length).toBe(3);
  });

  it("totals the REPORTED values only when the column is partly null", () => {
    render(
      <TokenRollupTable
        rollups={[
          rollup({ requests: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
          rollup({ dayKey: "2026-08-09", requests: 1, inputTokens: null, outputTokens: null, totalTokens: null, nullUsageRequests: 1 }),
        ]}
      />,
    );

    const totals = screen.getByTestId("rollup-totals");
    expect(within(totals).getByTestId("cell-totalTokens")).toHaveTextContent("110");
  });

  it("says WHY the table is empty instead of drawing zeroes", () => {
    render(<TokenRollupTable rollups={[]} />);

    expect(screen.getByText(EMPTY_ROLLUP_REASON)).toBeInTheDocument();
    expect(screen.queryByTestId("rollup-totals")).not.toBeInTheDocument();
    expect(pageText()).not.toMatch(/\b0\b/);
  });
});

// ---------------------------------------------------------------------------
// Tool mix + incomplete requests
// ---------------------------------------------------------------------------

describe("ToolMixPanel", () => {
  it("lists tools with their call counts and discloses the retention horizon", () => {
    render(
      <ToolMixPanel
        toolMix={[
          { toolName: "list_products", calls: 11 },
          { toolName: "get_stock", calls: 4 },
        ]}
        horizonNote="newest 10,000 runs retained — window may be clipped"
      />,
    );

    expect(screen.getByText("list_products")).toBeInTheDocument();
    expect(screen.getByText("11")).toBeInTheDocument();
    expect(screen.getByText(TOOL_MIX_DEFINITION)).toBeInTheDocument();
    expect(
      screen.getByText("newest 10,000 runs retained — window may be clipped"),
    ).toBeInTheDocument();
  });

  it("names the reason for an empty mix and STILL discloses the horizon", () => {
    render(<ToolMixPanel toolMix={[]} horizonNote="newest 10,000 runs retained — window may be clipped" />);

    expect(screen.getByText(EMPTY_TOOL_MIX_REASON)).toBeInTheDocument();
    expect(
      screen.getByText("newest 10,000 runs retained — window may be clipped"),
    ).toBeInTheDocument();
  });
});

describe("IncompleteRequestsDisclosure", () => {
  it("counts the never-finalized and the usage-less requests separately", () => {
    render(
      <IncompleteRequestsDisclosure
        rollups={[
          rollup({ requests: 4, running: 1, nullUsageRequests: 2 }),
          rollup({ dayKey: "2026-08-09", requests: 2, running: 1, nullUsageRequests: 1 }),
        ]}
      />,
    );

    expect(screen.getByTestId("incomplete-running")).toHaveTextContent("2");
    expect(screen.getByTestId("incomplete-null-usage")).toHaveTextContent("3");
    expect(screen.getByText(USAGE_DEFINITIONS.running)).toBeInTheDocument();
    expect(screen.getByText(USAGE_DEFINITIONS.nullUsageRequests)).toBeInTheDocument();
  });

  it("renders nothing to disclose when every request finalized WITH usage", () => {
    render(<IncompleteRequestsDisclosure rollups={[rollup({ running: 0, nullUsageRequests: 0 })]} />);

    expect(screen.queryByTestId("incomplete-running")).not.toBeInTheDocument();
    expect(screen.getByTestId("incomplete-none")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Range picker
// ---------------------------------------------------------------------------

describe("UsageRangePicker", () => {
  it("marks the active preset and reports the resolved window", () => {
    const onDaysChange = jest.fn();
    render(
      <UsageRangePicker
        days={DEFAULT_RANGE_DAYS}
        onDaysChange={onDaysChange}
        range={{ from: "2026-07-29", to: "2026-08-11" }}
      />,
    );

    expect(screen.getByRole("button", { name: "14 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("usage-range-label")).toHaveTextContent("2026-07-29");
    expect(screen.getByTestId("usage-range-label")).toHaveTextContent("2026-08-11");

    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    expect(onDaysChange).toHaveBeenCalledWith(30);
  });
});

describe("rangeForDays", () => {
  it("produces an INCLUSIVE UTC dayKey window ending on the given day", () => {
    expect(rangeForDays(14, new Date("2026-08-11T09:30:00.000Z"))).toEqual({
      from: "2026-07-29",
      to: "2026-08-11",
    });
    expect(rangeForDays(1, new Date("2026-08-11T23:59:59.999Z"))).toEqual({
      from: "2026-08-11",
      to: "2026-08-11",
    });
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

describe("AdminUsagePage", () => {
  it("asks for the default 14-day window on first paint", () => {
    render(<AdminUsagePage />);

    expect(mockUsageCalls[0]).toEqual(rangeForDays(DEFAULT_RANGE_DAYS));
    expect(screen.getByRole("button", { name: "14 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("re-queries when the range preset changes", () => {
    render(<AdminUsagePage />);

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));

    expect(mockUsageCalls[mockUsageCalls.length - 1]).toEqual(rangeForDays(7));
  });

  it("renders the rollup table, the tool mix, and the incomplete disclosure", () => {
    render(<AdminUsagePage />);

    expect(screen.getByTestId("rollup-totals")).toBeInTheDocument();
    expect(screen.getByText("get_stock")).toBeInTheDocument();
    expect(screen.getByTestId("incomplete-none")).toBeInTheDocument();
  });

  it("shows a skeleton while loading and a retryable error banner on failure", () => {
    mockUsageQuery = { data: undefined, isLoading: true, isError: false, refetch: jest.fn() };
    const { unmount } = render(<AdminUsagePage />);
    expect(screen.getByTestId("usage-loading")).toBeInTheDocument();
    unmount();

    const refetch = jest.fn();
    mockUsageQuery = { data: undefined, isLoading: false, isError: true, refetch };
    render(<AdminUsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  // Task 3.2 (shared-file rule): the anchor 3.1 left empty is now FILLED. The pin
  // flips from "no eval UI exists" to "the C9 section mounts HERE and nowhere else"
  // — the mount point is still the contract, only its occupancy changed.
  it("mounts the C9 eval section INSIDE the anchor (Task 3.2 owns the section)", () => {
    const { container } = render(<AdminUsagePage />);

    const anchor = container.querySelector(`#${EVAL_SECTION_MOUNT_ID}`);
    expect(anchor).toBeInTheDocument();
    expect(anchor?.children.length).toBeGreaterThan(0);
    expect(within(anchor as HTMLElement).getByText(EVAL_SECTION_HEADING)).toBeInTheDocument();
    // The C9 vocabulary exists ONLY inside the anchor — the tokens-only rollup half
    // of the page never grew eval prose.
    expect(anchor?.textContent ?? "").toMatch(/evaluation/i);
  });

  it("states the tokens-only and no-thread-content postures", () => {
    render(<AdminUsagePage />);

    expect(screen.getByText(TOKENS_ONLY_NOTE)).toBeInTheDocument();
    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();
  });

  it("shows NO dollar estimate anywhere", () => {
    mockUsageQuery = {
      data: usageData({
        tokenRollups: [rollup(), rollup({ kind: "title", inputTokens: null, outputTokens: null, totalTokens: null, nullUsageRequests: 1 })],
      }),
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
    render(<AdminUsagePage />);

    expect(pageText()).not.toMatch(/\$/);
    expect(pageText()).not.toMatch(/cost|price|usd|dollar|cents/i);
  });

  it("shows NO private thread content — ids, counts and tokens only", () => {
    render(<AdminUsagePage />);

    expect(textOutsideEvalSection()).not.toMatch(/thread|conversation|message|prompt|transcript/i);
  });
});
