/** @jest-environment jsdom */
//
// Facelift F1-7 (plan 2026-11-18-facelift-f1 REV 2; FL-D-12, FL-D-13; OC1-15,
// G1-15) — `QueryState`: one read's states, said truthfully. Error and empty
// are said only about an ANSWER:
//   - pending, a read in flight: the skeleton inside role="status";
//   - pending, disabled: `idle`, or nothing;
//   - failed with NO data: role="alert" — an AlertCircle, the title
//     (font-semibold) when given, the text (text-body-sm text-muted-foreground),
//     and a Retry outline button (RefreshCw) that calls refetch(). A failed
//     refresh over loaded data keeps the data;
//   - an answer (not placeholder data) that isEmpty: `empty`;
//   - otherwise children(data).

import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryState } from "@/components/ui/query-state";

type Q = React.ComponentProps<typeof QueryState<string[]>>["query"];

function query(over: Partial<Q>): Q {
  return {
    isPending: false,
    fetchStatus: "idle",
    isError: false,
    isPlaceholderData: false,
    data: undefined,
    refetch: jest.fn(),
    ...over,
  };
}

const children = jest.fn((data: string[]) => <ul data-testid="rows">{data.map((d) => <li key={d}>{d}</li>)}</ul>);

function renderState(q: Q, extra: Partial<React.ComponentProps<typeof QueryState<string[]>>> = {}) {
  return render(
    <QueryState
      query={q}
      skeleton={<div data-testid="skeleton" />}
      isEmpty={(data) => data.length === 0}
      empty={<p>Nothing here</p>}
      errorTitle="Failed to Load Things"
      errorText={<span>Check your <em>connection</em>.</span>}
      {...extra}
    >
      {children}
    </QueryState>
  );
}

beforeEach(() => children.mockClear());

describe("F1-7 — pending", () => {
  it.each(["fetching", "paused"] as const)("a read %s: the skeleton inside role=status, nothing else", (fetchStatus) => {
    renderState(query({ isPending: true, fetchStatus }));
    const status = screen.getByRole("status");
    expect(within(status).getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Nothing here")).toBeNull();
    expect(children).not.toHaveBeenCalled();
  });

  it("disabled (pending, idle): the `idle` node, never the skeleton", () => {
    renderState(query({ isPending: true, fetchStatus: "idle" }), { idle: <p>Pick a company</p> });
    expect(screen.getByText("Pick a company")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(children).not.toHaveBeenCalled();
  });

  it("disabled with no `idle`: nothing at all", () => {
    const { container } = renderState(query({ isPending: true, fetchStatus: "idle" }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("F1-7 — error, only with no data", () => {
  it("role=alert: icon, title (font-semibold), text (text-body-sm text-muted-foreground), Retry calls refetch", () => {
    const q = query({ isError: true });
    renderState(q);
    const alert = screen.getByRole("alert");
    expect(alert.querySelector("svg.lucide-circle-alert, svg.lucide-alert-circle")).not.toBeNull();
    expect(within(alert).getByText("Failed to Load Things").getAttribute("class")).toBe("font-semibold");
    // errorText is a ReactNode: the caller's span sits inside the styled wrapper.
    const text = within(alert).getByText(/Check your/).parentElement as HTMLElement;
    expect(text.getAttribute("class")).toBe("text-body-sm text-muted-foreground");
    expect(within(text).getByText("connection").tagName).toBe("EM");

    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("border-input"); // the outline variant
    expect(retry.querySelector("svg.lucide-refresh-cw")).not.toBeNull();
    fireEvent.click(retry);
    expect(q.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Nothing here")).toBeNull();
    expect(children).not.toHaveBeenCalled();
  });

  it("with no errorTitle, no title line", () => {
    renderState(query({ isError: true }), { errorTitle: undefined });
    const alert = screen.getByRole("alert");
    expect(alert.querySelector(".font-semibold")).toBeNull();
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a failed refresh over loaded data keeps the data — no alert", () => {
    renderState(query({ isError: true, data: ["a", "b"] }));
    expect(screen.getByTestId("rows")).toHaveTextContent("ab");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("F1-7 — empty, only on an answer", () => {
  it("a successful empty answer: `empty`, and children are not rendered", () => {
    renderState(query({ data: [] }));
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(children).not.toHaveBeenCalled();
  });

  it("placeholder [] (the previous key's rows while the next loads) is NOT empty: children render", () => {
    renderState(query({ data: [], isPlaceholderData: true, fetchStatus: "fetching" }));
    expect(screen.queryByText("Nothing here")).toBeNull();
    expect(children).toHaveBeenCalledWith([]);
  });

  it("a failed refresh over an empty ANSWER still says empty (the answer stands)", () => {
    renderState(query({ data: [], isError: true }));
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("F1-7 — otherwise, children(data)", () => {
  it("a successful answer renders children with the data", () => {
    renderState(query({ data: ["x"] }));
    expect(children).toHaveBeenCalledWith(["x"]);
    expect(screen.getByTestId("rows")).toHaveTextContent("x");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
