/** @jest-environment jsdom */
/**
 * THE /admin/reconciliation SHELL (pack C4a.1 + C4b.1; spec REV-7 §7).
 *
 * All three tabs the spec names now exist (M4b lands the finder and the
 * unmapped queue), so the pins here are the two ways a shell lies about that:
 *
 *   1. IT MOUNTS THE WRONG THING. Each tab mounts ITS content and only its
 *      content — a shell that renders every panel at once would fire three
 *      reads on a surface whose whole subject is what a read can and cannot
 *      see, and the M4a-era "coming in this release" title must be GONE rather
 *      than sitting on a tab that works.
 *   2. IT FORGETS THE URL. The `?tab=` sync is the `/admin/logs` idiom
 *      (`router.replace`), so a reload lands where the admin was — including
 *      on the two tabs this milestone enabled.
 *
 * Plus the nav entry, which is how anybody reaches the page at all.
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const replace = jest.fn();
let searchParams = new URLSearchParams("");

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
  usePathname: () => "/admin/reconciliation",
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// This suite is about the SHELL, so each real tab is stubbed at its mount
// point (the sibling admin suites' idiom).
jest.mock("@/components/admin/reconciliation/attribution-tab", () => ({
  AttributionTab: () => <div data-testid="attribution-tab-mount" />,
}));
jest.mock("@/components/admin/reconciliation/exceptions-tab", () => ({
  ExceptionsTab: () => <div data-testid="exceptions-tab-mount" />,
}));
jest.mock("@/components/admin/reconciliation/unmapped-tab", () => ({
  UnmappedTab: () => <div data-testid="unmapped-tab-mount" />,
}));

import { ReconciliationPageShell } from "@/components/admin/reconciliation/page-shell";
import { AdminSubNav } from "@/components/admin/admin-sub-nav";

beforeEach(() => {
  jest.clearAllMocks();
  searchParams = new URLSearchParams("");
});

describe("ReconciliationPageShell", () => {
  it("defaults to the attribution tab and syncs it into ?tab= (the /admin/logs idiom)", async () => {
    render(<ReconciliationPageShell />);

    expect(screen.getByTestId("attribution-tab-mount")).toBeInTheDocument();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/admin/reconciliation?tab=attribution"),
    );
  });

  it("every tab is live — the M4b tabs are enabled and carry no 'coming' title", () => {
    render(<ReconciliationPageShell />);

    const exceptions = screen.getByRole("tab", { name: /exceptions/i });
    const unmapped = screen.getByRole("tab", { name: /unmapped/i });

    expect(exceptions).toBeEnabled();
    expect(unmapped).toBeEnabled();
    expect(exceptions).not.toHaveAttribute("title");
    expect(unmapped).not.toHaveAttribute("title");
  });

  it("opens the tab the URL names, and mounts ONLY that tab", async () => {
    searchParams = new URLSearchParams("tab=exceptions");

    render(<ReconciliationPageShell />);

    expect(screen.getByTestId("exceptions-tab-mount")).toBeInTheDocument();
    expect(screen.queryByTestId("attribution-tab-mount")).toBeNull();
    expect(screen.queryByTestId("unmapped-tab-mount")).toBeNull();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/admin/reconciliation?tab=exceptions"),
    );
  });

  it("switching to the unmapped tab mounts it and syncs the URL", async () => {
    const user = userEvent.setup();
    render(<ReconciliationPageShell />);

    await user.click(screen.getByRole("tab", { name: /unmapped/i }));

    expect(screen.getByTestId("unmapped-tab-mount")).toBeInTheDocument();
    expect(screen.queryByTestId("attribution-tab-mount")).toBeNull();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/admin/reconciliation?tab=unmapped"),
    );
  });

  it("falls back to attribution when the URL names a tab that does not exist", async () => {
    searchParams = new URLSearchParams("tab=nonsense");

    render(<ReconciliationPageShell />);

    expect(screen.getByTestId("attribution-tab-mount")).toBeInTheDocument();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/admin/reconciliation?tab=attribution"),
    );
  });
});

describe("AdminSubNav", () => {
  it("carries the Reconciliation entry, straight after Reports", () => {
    render(<AdminSubNav />);

    const link = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "/admin/reconciliation");
    expect(link).toBeDefined();
    expect(link).toHaveTextContent("Reconciliation");

    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs.indexOf("/admin/reconciliation")).toBe(hrefs.indexOf("/admin/reports") + 1);
  });
});
