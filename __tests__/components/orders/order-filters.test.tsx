/** @jest-environment jsdom */
/**
 * `components/orders/order-filters.tsx` — § P2-B3-1R, M-b3 fix 11 (MS-1-3).
 *
 * `DesktopFilters` and `MobileFilters` are declared inside `OrderFilters`'s
 * render. Mounted as `<MobileFilters />` they were a NEW component type on every
 * render, so each keystroke (the page owns `searchQuery`, so every character
 * re-renders the filters) remounted the search input: focus, and the phone
 * keyboard, were lost after one character. Called as functions, the input is
 * the same element for the whole edit.
 *
 * The harness owns `searchQuery` the way `app/(app)/orders/page.tsx` does, so
 * every typed character re-renders `OrderFilters` exactly as the page would.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const isMobileMock = jest.fn(() => false);
jest.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileMock(),
}));

import { OrderFilters } from "@/components/orders/order-filters";

function Harness() {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [platform, setPlatform] = React.useState<"ALL" | "SHOPIFY" | "WOOCOMMERCE">("ALL");
  const [status, setStatus] = React.useState<"all" | "pending" | "processing" | "fulfilled" | "cancelled">("all");
  return (
    <OrderFilters
      companies={[{ id: "co_a", name: "Awake", slug: "awake" }]}
      selectedCompanyId="co_a"
      onCompanyChange={() => {}}
      platform={platform}
      onPlatformChange={setPlatform}
      status={status}
      onStatusChange={(s) => setStatus(s as typeof status)}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
    />
  );
}

beforeAll(() => {
  // Radix Select / Tabs need these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  isMobileMock.mockReset();
});

describe.each([
  ["desktop", false, "Search by order number..."],
  ["phone", true, "Search orders..."],
])("the %s search box (MS-1-3)", (_label, mobile, placeholder) => {
  it("after 3 typed characters, the SAME input element is still focused", async () => {
    isMobileMock.mockReturnValue(mobile);
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByPlaceholderText(placeholder);
    await user.click(input);
    expect(input).toHaveFocus();

    await user.keyboard("abc");

    // The same DOM node — not a remounted look-alike — holds focus and every
    // character the operator typed.
    expect(screen.getByPlaceholderText(placeholder)).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("abc");
  });
});
