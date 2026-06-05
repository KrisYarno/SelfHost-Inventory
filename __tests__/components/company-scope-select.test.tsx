/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { CompanyScopeSelect } from "@/components/analytics/company-scope-select";

jest.mock("@/hooks/use-external-orders", () => ({ useUserCompanies: jest.fn() }));
import { useUserCompanies } from "@/hooks/use-external-orders";
const mockHook = useUserCompanies as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test("renders 'All my companies' default plus each member company", () => {
  mockHook.mockReturnValue({
    data: { companies: [{ id: "c1", name: "Acme", slug: "acme" }] },
    isLoading: false,
    error: null,
  });
  render(<CompanyScopeSelect value={undefined} onChange={jest.fn()} />);
  expect(screen.getByText("All my companies")).toBeInTheDocument();
});

test("error falls back to an all-companies message, never a blank/crash", () => {
  mockHook.mockReturnValue({ data: undefined, isLoading: false, error: new Error("boom") });
  render(<CompanyScopeSelect value={undefined} onChange={jest.fn()} />);
  expect(screen.getByText(/showing all your companies/i)).toBeInTheDocument();
});

test("the selector sources its company list from the memberships-only flag (ER-D3)", () => {
  mockHook.mockReturnValue({
    data: { companies: [] },
    isLoading: false,
    error: null,
  });
  render(<CompanyScopeSelect value={undefined} onChange={jest.fn()} />);
  // The analytics selector must request the memberships-only list so the picker equals
  // the rollup source (the omit-companyId "all" sum over the caller's memberships).
  expect(mockHook).toHaveBeenCalledWith(true);
});
