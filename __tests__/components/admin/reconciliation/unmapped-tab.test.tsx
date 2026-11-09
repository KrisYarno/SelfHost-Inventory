/** @jest-environment jsdom */
/**
 * THE UNMAPPED-AGING TAB (pack C4b.1; spec REV-7 §4.4).
 *
 * A queue of external order lines nobody has mapped, at the grain a person
 * actually maps — integration, external product, variant. The pins:
 *
 *   1. THE BUCKETS ARE THE PRODUCER'S, AND THEY SUM TO `count`. `unknown` is
 *      its own band and carries its REASON as its label; folding it into `90+`
 *      would age a group nobody can age.
 *   2. AN AGE NOBODY CAN COMPUTE IS SAID, NOT ZEROED (R-2). `ageDays === null`
 *      renders `ageReason`.
 *   3. THE DEEP LINK WARNS. Following it loads the live store catalog, and the
 *      label says so — the warning is the producer's string.
 *   4. THE BOUND IS SAID OUT LOUD. `moreCount` rides with the page.
 *
 * The hook module is mocked wholesale — the M4a component-suite idiom.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UnmappedGroup } from "@/lib/reconciliation/unmapped";

const useUnmappedMock = jest.fn();

jest.mock("@/hooks/use-admin", () => ({
  useUnmapped: (...args: unknown[]) => useUnmappedMock(...args),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { UnmappedTab, UNMAPPED_EMPTY_STATE } from "@/components/admin/reconciliation/unmapped-tab";

type Page = {
  groups: UnmappedGroup[];
  buckets: Record<UnmappedGroup["bucket"], number>;
  count: number;
  moreCount: number;
  nextCursor: string | null;
  unknownExcluded: number;
  noStoreProductItems: number;
  notes: string[];
};

function makeGroup(over: Partial<UnmappedGroup> = {}): UnmappedGroup {
  return {
    integrationId: "int-1",
    integrationName: "Acme Store",
    platform: "WOOCOMMERCE",
    externalProductId: "P1",
    externalVariantId: "V1",
    sku: "SKU-1",
    name: "Widget",
    itemCount: 3,
    oldestOrderCreatedAt: "2026-05-01T00:00:00.000Z",
    ageDays: 111,
    ageReason: null,
    bucket: "90+",
    link: {
      href: "/admin/product-mappings/int-1/map?externalProductId=P1&externalVariantId=V1&sku=SKU-1",
      warning: "loads the live store catalog",
    },
    ...over,
  };
}

function makePage(over: Partial<Page> = {}): Page {
  return {
    groups: [makeGroup()],
    buckets: { "0-7": 2, "8-30": 3, "31-90": 0, "90+": 1, unknown: 4 },
    count: 10,
    moreCount: 0,
    nextCursor: null,
    unknownExcluded: 0,
    noStoreProductItems: 0,
    notes: [],
    ...over,
  };
}

function setPage(page: Page | undefined, extra: Record<string, unknown> = {}) {
  useUnmappedMock.mockReturnValue({
    data: page,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    ...extra,
  });
}

function lastInput(): Record<string, unknown> {
  const calls = useUnmappedMock.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  setPage(makePage());
});

describe("the bucket chips", () => {
  it("carries every band with its count, straight off the producer", () => {
    render(<UnmappedTab />);

    expect(screen.getByTestId("bucket-chip-0-7")).toHaveTextContent("0-7 · 2");
    expect(screen.getByTestId("bucket-chip-8-30")).toHaveTextContent("8-30 · 3");
    expect(screen.getByTestId("bucket-chip-31-90")).toHaveTextContent("31-90 · 0");
    expect(screen.getByTestId("bucket-chip-90+")).toHaveTextContent("90+ · 1");
  });

  it("the unknown band is LABELLED with its reason and never folded into 90+", () => {
    render(<UnmappedTab />);

    const unknown = screen.getByTestId("bucket-chip-unknown");
    expect(unknown).toHaveTextContent(
      "unknown age — the order carries no external creation date · 4",
    );
    expect(screen.getByTestId("bucket-chip-90+").textContent).not.toContain("5");
  });

  // QA-4: an age filter cannot say anything about a group whose age nobody can
  // compute, so it drops them — and the unknown chip then reads 0, which a
  // reader takes for "there are none". The producer's note rides beside it.
  it("says how many unknown-age groups the filter is hiding (QA-4)", () => {
    setPage(
      makePage({
        buckets: { "0-7": 0, "8-30": 0, "31-90": 0, "90+": 1, unknown: 0 },
        unknownExcluded: 4,
        notes: [
          "4 unknown-age groups are outside this age filter — clear the filter to see them",
        ],
      }),
    );
    render(<UnmappedTab />);

    expect(screen.getByTestId("unmapped-note")).toHaveTextContent(
      "4 unknown-age groups are outside this age filter — clear the filter to see them",
    );
  });

  it("says nothing when the filter is hiding nothing", () => {
    render(<UnmappedTab />);
    expect(screen.queryByTestId("unmapped-note")).not.toBeInTheDocument();
  });

  // Hand-typed lines plan, C4: lines with no store product are never groups,
  // only a count — and the producer's sentence about them renders beside the
  // QA-4 note, in the producer's order.
  it("renders the no-store-product note, after the unknown-excluded note", () => {
    const noStoreNote =
      "569 order lines have no store product id (for example, they were typed by hand in the store's order screen). They can't be mapped and stay unattributed. Counted across all ages.";
    setPage(
      makePage({
        unknownExcluded: 4,
        noStoreProductItems: 569,
        notes: [
          "4 unknown-age groups are outside this age filter — clear the filter to see them",
          noStoreNote,
        ],
      }),
    );
    render(<UnmappedTab />);

    const notes = screen.getAllByTestId("unmapped-note");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent(
      "4 unknown-age groups are outside this age filter — clear the filter to see them",
    );
    expect(notes[1]).toHaveTextContent(noStoreNote);
  });
});

describe("the rows", () => {
  it("names the integration, the line, the item count and the age", () => {
    render(<UnmappedTab />);

    const row = screen.getByTestId("unmapped-row-int-1::P1::V1");
    expect(row).toHaveTextContent("Acme Store");
    expect(row).toHaveTextContent("Widget");
    expect(row).toHaveTextContent("SKU-1");
    expect(row).toHaveTextContent("3");
    expect(row).toHaveTextContent("111 days");
  });

  it("an age nobody can compute renders the REASON, never a 0", () => {
    setPage(
      makePage({
        groups: [
          makeGroup({
            externalVariantId: null,
            sku: null,
            ageDays: null,
            oldestOrderCreatedAt: null,
            ageReason: "the order carries no external creation date",
            bucket: "unknown",
          }),
        ],
      }),
    );
    render(<UnmappedTab />);

    const age = screen.getByTestId("unmapped-age-int-1::P1::");
    expect(age).toHaveTextContent("the order carries no external creation date");
    expect(age.textContent).not.toContain("0 days");
  });

  it("a line with no sku says so rather than rendering an empty cell", () => {
    setPage(makePage({ groups: [makeGroup({ externalVariantId: null, sku: null })] }));
    render(<UnmappedTab />);

    expect(screen.getByTestId("unmapped-row-int-1::P1::")).toHaveTextContent("no sku");
  });

  it("the deep link is the producer's href, and the label carries its warning", () => {
    render(<UnmappedTab />);

    const link = screen.getByTestId("unmapped-link-int-1::P1::V1");
    expect(link).toHaveAttribute(
      "href",
      "/admin/product-mappings/int-1/map?externalProductId=P1&externalVariantId=V1&sku=SKU-1",
    );
    expect(link).toHaveTextContent("Map it — loads the live store catalog");
  });
});

describe("bounds, filter and the empty state", () => {
  it("says what the page holds and what it left behind", () => {
    setPage(makePage({ moreCount: 9 }));
    render(<UnmappedTab />);

    expect(screen.getByTestId("unmapped-count")).toHaveTextContent("Showing 1 of 10 groups.");
    expect(screen.getByTestId("unmapped-more-count")).toHaveTextContent("9 more in this list.");
  });

  it("the age filter is the SERVER's, and clearing it drops the parameter", async () => {
    const user = userEvent.setup();
    render(<UnmappedTab />);

    expect(lastInput().olderThanDays).toBeUndefined();

    await user.selectOptions(screen.getByLabelText("Age"), "30");
    await waitFor(() => expect(lastInput().olderThanDays).toBe(30));

    await user.selectOptions(screen.getByLabelText("Age"), "");
    await waitFor(() => expect(lastInput().olderThanDays).toBeUndefined());
  });

  it("a filter change drops the cursor", async () => {
    const user = userEvent.setup();
    setPage(makePage({ moreCount: 9, nextCursor: "cursor-2" }));
    render(<UnmappedTab />);

    await user.click(screen.getByRole("button", { name: /next page/i }));
    await waitFor(() => expect(lastInput().cursor).toBe("cursor-2"));

    await user.selectOptions(screen.getByLabelText("Age"), "7");
    await waitFor(() => expect(lastInput().cursor).toBeUndefined());
  });

  it("an empty list says so, bounded by the filter that produced it", () => {
    setPage(
      makePage({
        groups: [],
        buckets: { "0-7": 0, "8-30": 0, "31-90": 0, "90+": 0, unknown: 0 },
        count: 0,
      }),
    );
    render(<UnmappedTab />);

    expect(screen.getByTestId("unmapped-empty")).toHaveTextContent(UNMAPPED_EMPTY_STATE);
  });

  it("the empty state speaks of MAPPABLE lines (no-store-product lines are only counted)", () => {
    expect(UNMAPPED_EMPTY_STATE).toBe("No mappable external order lines match this filter.");
  });
});

describe("mobile", () => {
  it("renders the cards beside the table (the md: breakpoint pair)", () => {
    setPage(
      makePage({
        groups: [makeGroup(), makeGroup({ externalProductId: "P2", externalVariantId: null })],
      }),
    );
    render(<UnmappedTab />);

    const cards = screen.getByTestId("unmapped-cards");
    expect(within(cards).getByTestId("unmapped-card-int-1::P1::V1")).toBeInTheDocument();
    expect(within(cards).getByTestId("unmapped-card-int-1::P2::")).toBeInTheDocument();
    expect(cards.className).toContain("md:hidden");
    expect(screen.getByTestId("unmapped-table-wrap").className).toContain("hidden md:block");
  });
});

// ---------------------------------------------------------------------------
// QA-5 — what the error card is allowed to say
// ---------------------------------------------------------------------------

describe("the error card (QA-5)", () => {
  it("renders the server's 4xx sentence VERBATIM, and the generic copy for a 5xx", () => {
    setPage(undefined, {
      isError: true,
      error: Object.assign(new Error("Request failed (400)"), {
        status: 400,
        serverMessage: "invalid cursor",
      }),
    });
    const view = render(<UnmappedTab />);
    expect(screen.getByTestId("reconciliation-error")).toHaveTextContent("invalid cursor");
    view.unmount();

    setPage(undefined, {
      isError: true,
      error: Object.assign(new Error("Request failed (500)"), { status: 500 }),
    });
    render(<UnmappedTab />);
    expect(screen.getByTestId("reconciliation-error")).toHaveTextContent(
      "Could not load the unmapped lines.",
    );
  });
});
