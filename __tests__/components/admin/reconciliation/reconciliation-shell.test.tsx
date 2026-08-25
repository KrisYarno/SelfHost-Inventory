/** @jest-environment jsdom */
/**
 * THE /admin/reconciliation SHELL (pack C4a.1; spec REV-7 §7).
 *
 * Three tabs are named by the spec and exactly ONE of them exists in this
 * milestone. The pins here are the two ways a shell lies about that:
 *
 *   1. IT PRETENDS THE OTHER TABS WORK. `exceptions` and `unmapped` are
 *      DISABLED and say why; nothing is mounted behind them. A tab that opens
 *      onto an empty panel reads as "there is nothing here", which is a
 *      different (and false) statement from "this ships next".
 *   2. IT FORGETS THE URL. The `?tab=` sync is the `/admin/logs` idiom
 *      (`router.replace`), so a reload lands where the admin was.
 *
 * Plus the nav entry, which is how anybody reaches the page at all.
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";

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

// This suite is about the SHELL, so the one real tab is stubbed at its mount
// point (the sibling admin suites' idiom).
jest.mock("@/components/admin/reconciliation/attribution-tab", () => ({
  AttributionTab: () => <div data-testid="attribution-tab-mount" />,
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

  it("mounts NOTHING behind the two tabs that ship later, and says they are coming", () => {
    render(<ReconciliationPageShell />);

    const exceptions = screen.getByRole("tab", { name: /exceptions/i });
    const unmapped = screen.getByRole("tab", { name: /unmapped/i });

    expect(exceptions).toBeDisabled();
    expect(unmapped).toBeDisabled();
    expect(exceptions).toHaveAttribute("title", "coming in this release");
    expect(unmapped).toHaveAttribute("title", "coming in this release");
  });

  it("falls back to attribution when the URL names a tab this release cannot show", async () => {
    searchParams = new URLSearchParams("tab=exceptions");

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
