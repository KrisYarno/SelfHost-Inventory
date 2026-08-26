/** @jest-environment jsdom */
/**
 * THE EXCEPTIONS TAB (pack C4b.1; spec REV-7 §4.3 / D5).
 *
 * Part 1 is a FINDER: it filters the rows `inventory_exceptions` already
 * carries and sends a human to the surface that resolves each one. So the pins
 * here are the four ways a finder stops being one:
 *
 *   1. IT RE-DERIVES THE SUBJECT. Every sentence, every money decision and
 *      every link on this tab was computed by the producer (C2c.1). The tab
 *      renders `subjectSummary` / `money` / `link` and NEVER reaches into
 *      `subject.*` — pinned as a source scan, because a component that reads
 *      one field of one kind's subject is how the renderer table stops being
 *      closed.
 *   2. IT INVENTS A DESTINATION. A row with no link renders the producer's
 *      copy ("removed line", "no order to open …") in place of a link, and a
 *      link that talks to the live store says so.
 *   3. IT SHOWS A NUMBER WHERE THERE IS NONE. `money.cents === null` renders
 *      the NAMED reason, never $0.00 (R-2).
 *   4. IT FILTERS IN THE BROWSER. Kind / status / severity / age are the
 *      SERVER's filters — the tab asks for them, so `count` stays truthful.
 *
 * The hook module is mocked wholesale — the M4a component-suite idiom
 * (`attribution-tab.test.tsx`, itself the sibling `lane3-admin-overview` idiom).
 */

import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExceptionRowView } from "@/lib/reconciliation/exceptions";

const useExceptionsMock = jest.fn();

jest.mock("@/hooks/use-admin", () => ({
  useExceptions: (...args: unknown[]) => useExceptionsMock(...args),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  ExceptionsTab,
  EXCEPTIONS_EMPTY_STATE,
  EXCEPTIONS_FILTERED_EMPTY_STATE,
} from "@/components/admin/reconciliation/exceptions-tab";

type Page = {
  rows: ExceptionRowView[];
  count: number;
  moreCount: number;
  nextCursor: string | null;
};

function makeRow(over: Partial<ExceptionRowView> = {}): ExceptionRowView {
  return {
    id: 1,
    key: "recv-discrepancy:9001",
    kind: "recv-discrepancy",
    severity: "medium",
    subjectSummary: "8 counted vs 10 expected — 2 short",
    money: { cents: 2500, label: "supplier shortage" },
    firstSeenAt: "2026-08-18T09:00:00.000Z",
    lastSeenAt: "2026-08-19T09:00:00.000Z",
    ageDays: 6,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    note: null,
    link: { href: "/receiving/cksupply1?line=9001", label: "Open the order line" },
    ...over,
  };
}

function makePage(over: Partial<Page> = {}): Page {
  return { rows: [makeRow()], count: 1, moreCount: 0, nextCursor: null, ...over };
}

function setPage(page: Page | undefined, extra: Record<string, unknown> = {}) {
  useExceptionsMock.mockReturnValue({
    data: page,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    ...extra,
  });
}

/** The input the tab last asked the server for. */
function lastInput(): Record<string, unknown> {
  const calls = useExceptionsMock.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  setPage(makePage());
});

describe("the producer's strings, and nothing else", () => {
  it("renders the summary, the money label and the deep link the producer computed", () => {
    render(<ExceptionsTab />);

    const row = screen.getByTestId("exception-row-1");
    expect(row).toHaveTextContent("8 counted vs 10 expected — 2 short");
    expect(row).toHaveTextContent("recv-discrepancy");
    expect(row).toHaveTextContent("medium");
    expect(screen.getByTestId("exception-money-1")).toHaveTextContent("supplier shortage $25.00");
    // Both ends of the row's life (spec §4.3), and the age on the axis the
    // filter cuts (`lastSeenAt`).
    const seen = screen.getByTestId("exception-seen-1");
    expect(seen).toHaveTextContent("6 days old");
    expect(seen).toHaveTextContent(`first seen ${new Date("2026-08-18T09:00:00.000Z").toLocaleString()}`);
    expect(seen).toHaveTextContent(new Date("2026-08-19T09:00:00.000Z").toLocaleString());
    expect(screen.getByTestId("exception-link-1")).toHaveAttribute(
      "href",
      "/receiving/cksupply1?line=9001",
    );
    expect(screen.getByTestId("exception-link-1")).toHaveTextContent("Open the order line");
  });

  it("NEVER reads subject.* — the renderer table is closed, and it lives in the producer", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../../../components/admin/reconciliation/exceptions-tab.tsx"),
      "utf8",
    );
    // `subjectSummary` is the producer's own field and carries no dot.
    expect(source).not.toMatch(/subject\s*\.\s*[A-Za-z_]/);
    expect(source).not.toMatch(/\.\s*subject\b/);
    expect(source).toContain("subjectSummary");
  });

  it("money nobody can compute renders the NAMED reason, never $0.00", () => {
    setPage(
      makePage({
        rows: [makeRow({ money: { cents: null, reason: "Not priced" } })],
      }),
    );
    render(<ExceptionsTab />);

    const money = screen.getByTestId("exception-money-1");
    expect(money).toHaveTextContent("Not priced");
    expect(money.textContent).not.toContain("$0.00");
  });

  it("a defensively-rendered kind still renders — the finder never blanks a row", () => {
    setPage(
      makePage({
        rows: [
          makeRow({
            kind: "gap-order",
            severity: "high",
            subjectSummary: "(gap-order) — no summary renderer yet; raw subject keys: none",
            money: { cents: null, reason: "no money renderer for this kind yet" },
            link: { href: null, copy: "no destination yet (Part 2)" },
          }),
        ],
      }),
    );
    render(<ExceptionsTab />);

    expect(screen.getByTestId("exception-row-1")).toHaveTextContent(
      "(gap-order) — no summary renderer yet; raw subject keys: none",
    );
    expect(screen.getByTestId("exception-no-link-1")).toHaveTextContent(
      "no destination yet (Part 2)",
    );
  });
});

describe("the links (spec D5)", () => {
  it("a row with no destination renders the producer's copy instead of a link", () => {
    setPage(
      makePage({
        rows: [
          makeRow({
            link: {
              href: null,
              copy: "no order to open (the line's order id was not recorded)",
            },
          }),
        ],
      }),
    );
    render(<ExceptionsTab />);

    expect(screen.getByTestId("exception-no-link-1")).toHaveTextContent(
      "no order to open (the line's order id was not recorded)",
    );
    expect(screen.queryByTestId("exception-link-1")).toBeNull();
  });

  it("a removed line says so — the line is gone, and the link would land on nothing", () => {
    setPage(makePage({ rows: [makeRow({ link: { href: null, copy: "removed line" } })] }));
    render(<ExceptionsTab />);

    expect(screen.getByTestId("exception-no-link-1")).toHaveTextContent("removed line");
  });

  it("a link that talks to the live store carries its warning", () => {
    setPage(
      makePage({
        rows: [
          makeRow({
            link: {
              href: "/admin/product-review",
              label: "Open product review",
              warning: "loads the live store catalog",
            },
          }),
        ],
      }),
    );
    render(<ExceptionsTab />);

    expect(screen.getByTestId("exception-link-warning-1")).toHaveTextContent(
      "loads the live store catalog",
    );
  });

  it("no warning, no warning element — the cue means something only when it is rare", () => {
    render(<ExceptionsTab />);
    expect(screen.queryByTestId("exception-link-warning-1")).toBeNull();
  });
});

describe("the filters are the SERVER's", () => {
  it("defaults to the OPEN half — the rows somebody still has to do something about", () => {
    render(<ExceptionsTab />);
    expect(lastInput().resolved).toBe("open");
  });

  it("kind, status, severity and age all ride into the request", async () => {
    const user = userEvent.setup();
    render(<ExceptionsTab />);

    await user.selectOptions(screen.getByLabelText("Kind"), "labeling-loss");
    await waitFor(() => expect(lastInput().kind).toBe("labeling-loss"));

    await user.selectOptions(screen.getByLabelText("Status"), "all");
    await waitFor(() => expect(lastInput().resolved).toBe("all"));

    await user.selectOptions(screen.getByLabelText("Severity"), "high");
    await waitFor(() => expect(lastInput().severity).toBe("high"));

    await user.selectOptions(screen.getByLabelText("Age"), "30");
    await waitFor(() => expect(lastInput().olderThanDays).toBe(30));
  });

  it("clearing a filter drops it from the request rather than sending an empty string", async () => {
    const user = userEvent.setup();
    render(<ExceptionsTab />);

    await user.selectOptions(screen.getByLabelText("Kind"), "labeling-loss");
    await waitFor(() => expect(lastInput().kind).toBe("labeling-loss"));

    await user.selectOptions(screen.getByLabelText("Kind"), "");
    await waitFor(() => expect(lastInput().kind).toBeUndefined());
  });

  it("a filter change drops the cursor — page 2 of one filter is not page 2 of another", async () => {
    const user = userEvent.setup();
    setPage(makePage({ moreCount: 4, nextCursor: "cursor-2" }));
    render(<ExceptionsTab />);

    await user.click(screen.getByRole("button", { name: /next page/i }));
    await waitFor(() => expect(lastInput().cursor).toBe("cursor-2"));

    await user.selectOptions(screen.getByLabelText("Severity"), "low");
    await waitFor(() => expect(lastInput().cursor).toBeUndefined());
  });
});

describe("bounds and the empty state", () => {
  it("says what the page holds and what it left behind", () => {
    setPage(makePage({ count: 12, moreCount: 11 }));
    render(<ExceptionsTab />);

    expect(screen.getByTestId("exceptions-count")).toHaveTextContent(
      "Showing 1 of 12 exceptions.",
    );
    expect(screen.getByTestId("exceptions-more-count")).toHaveTextContent("11 more match these filters.");
  });

  it("day one renders the empty state VERBATIM", () => {
    setPage(makePage({ rows: [], count: 0 }));
    render(<ExceptionsTab />);

    expect(screen.getByTestId("exceptions-empty")).toHaveTextContent(
      "No exceptions raised yet — receiving and labeling write them as they find them.",
    );
    expect(EXCEPTIONS_EMPTY_STATE).toBe(
      "No exceptions raised yet — receiving and labeling write them as they find them.",
    );
  });

  // OC-4: the day-one sentence is a claim about the REGISTER, and a filtered page
  // with nothing on it is not evidence for it. Both halves of the condition —
  // no filter AND nothing counted — have to hold before it may be said.
  it("a FILTERED page with rows behind it never claims the register is empty", async () => {
    const user = userEvent.setup();
    setPage(makePage({ rows: [], count: 12, moreCount: 0 }));
    render(<ExceptionsTab />);

    await user.selectOptions(screen.getByLabelText("Severity"), "high");

    const empty = screen.getByTestId("exceptions-empty");
    expect(empty).toHaveTextContent(EXCEPTIONS_FILTERED_EMPTY_STATE);
    expect(EXCEPTIONS_FILTERED_EMPTY_STATE).toBe("No exceptions match these filters.");
    expect(empty.textContent).not.toContain("No exceptions raised yet");
    expect(empty).toHaveTextContent("12");
  });

  it("a filter that matches nothing says the FILTER, not day one", async () => {
    const user = userEvent.setup();
    setPage(makePage({ rows: [], count: 0 }));
    render(<ExceptionsTab />);

    await user.selectOptions(screen.getByLabelText("Kind"), "labeling-loss");

    const empty = screen.getByTestId("exceptions-empty");
    expect(empty).toHaveTextContent("No exceptions match these filters.");
    expect(empty.textContent).not.toContain("No exceptions raised yet");
  });
});

describe("what a resolved row says", () => {
  it("names who settled it, when, and with what resolution", () => {
    setPage(
      makePage({
        rows: [
          makeRow({
            resolvedAt: "2026-08-20T09:00:00.000Z",
            resolvedBy: { id: 7, username: "kris" },
            resolution: "supplier-credited",
            note: "credit note 41",
          }),
        ],
      }),
    );
    render(<ExceptionsTab />);

    const row = screen.getByTestId("exception-row-1");
    expect(row).toHaveTextContent("supplier-credited");
    expect(row).toHaveTextContent("kris");
    expect(row).toHaveTextContent("credit note 41");
  });

  it("an open row says OPEN rather than leaving the cell blank", () => {
    render(<ExceptionsTab />);
    expect(screen.getByTestId("exception-row-1")).toHaveTextContent("Open");
  });
});

describe("mobile", () => {
  it("renders the cards beside the table (the md: breakpoint pair)", () => {
    setPage(makePage({ rows: [makeRow(), makeRow({ id: 2, key: "labeling-loss:7" })], count: 2 }));
    render(<ExceptionsTab />);

    const cards = screen.getByTestId("exceptions-cards");
    expect(within(cards).getByTestId("exception-card-1")).toBeInTheDocument();
    expect(within(cards).getByTestId("exception-card-2")).toBeInTheDocument();
    expect(cards.className).toContain("md:hidden");
    expect(screen.getByTestId("exceptions-table-wrap").className).toContain("hidden md:block");
  });
});
