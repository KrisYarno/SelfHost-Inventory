/** @jest-environment jsdom */
/**
 * `app/(app)/admin/users/page.tsx` — § P2-B3-1R, M-b2 fix 2 (MS-3-1), the PAGE
 * arm. The dialog's own body pins are `edit-user-dialog.test.tsx`.
 *
 * The page used to keep EditUserDialog mounted and never cleared `editingUser`;
 * the dialog re-seeded its form from an effect keyed on the user OBJECT. A
 * reopen of the same user hands it the same object (react-query structural
 * sharing), so the effect did not run and the cancelled draft came back: tick
 * Admin, Cancel, reopen to fix a username, Save — and the role grant rode along.
 *
 * Now the page mounts the dialog per open and nulls its subject on any close,
 * so every open is a fresh mount from the stored user.
 *
 * FR-R1 (2), CR-OC-3: and the form is seeded from a read issued AFTER the Edit
 * tap — the page refetches its users query and mounts the form with the
 * refetched row of that id — never from the list row the tap came from. The
 * membership set is sent whole and the route deletes every membership absent
 * from it, so a stale row silently removed a grant made since it was read.
 * `Loading…` until that read answers; `Couldn't load this user.` and no form
 * when it failed or the user is gone.
 *
 * The REAL dialog renders here; the data hooks are stubbed, and the user list
 * hands back the SAME user object on every render (as react-query does). Its
 * `refetch` answers, by default, with that same list — a fresh read that finds
 * nothing changed — stamped, as a real result is, with the time it was stored
 * (`dataUpdatedAt`; FR-R2 (14) checks it against the tap). The same flow under
 * a REAL QueryClient and the real hook is `users-page-fresh-read.test.tsx`.
 * `UserTable` is reduced to one Edit button per user (its row menu is not under
 * test).
 */

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

// One stable user object, returned on every render (react-query's structural
// sharing hands the dialog the same reference on a reopen).
const mockUser = {
  id: 7,
  email: "packer@example.test",
  username: "packer",
  isAdmin: false,
  isApproved: true,
  defaultLocationId: 1,
  emailAlerts: false,
  minLocationEmailAlerts: false,
  minCombinedEmailAlerts: false,
  companies: [{ companyId: "co_a", companyName: "Awake" }],
};
type MockUsersData = { users: Array<typeof mockUser>; pagination: { totalPages: number } };
// `let`: a pin can swap in a stale list row (the factories read these on call).
let mockUsersData: MockUsersData = { users: [mockUser], pagination: { totalPages: 1 } };
const mockPendingData = { users: [] };
const mockLocations = [{ id: 1, name: "Main" }];
const DEFAULT_COMPANIES = [{ id: "co_a", name: "Awake", slug: "awake", createdAt: "2026-01-01" }];
let mockCompanies = DEFAULT_COMPANIES;
// The users query's `refetch` — the fresh read the Edit tap issues.
const mockRefetch = jest.fn();
const mockUpdateUser = jest.fn(async () => ({}));
const mockMutation = () => ({ mutateAsync: jest.fn(async () => ({})), isPending: false });

jest.mock("@/hooks/use-admin", () => ({
  useAdminPendingUsers: () => ({ data: mockPendingData, error: null }),
  useAdminUsers: () => ({ data: mockUsersData, isLoading: false, error: null, refetch: mockRefetch }),
  useLocationOptions: () => ({ data: mockLocations }),
  useAdminCompanies: () => ({ data: mockCompanies }),
  useApproveUser: () => mockMutation(),
  useRejectUser: () => mockMutation(),
  useDeleteUser: () => mockMutation(),
  useBulkApproveUsers: () => mockMutation(),
  useBulkRejectUsers: () => mockMutation(),
  useBulkDeleteUsers: () => mockMutation(),
  useUpdateUser: () => ({ mutateAsync: mockUpdateUser, isPending: false }),
}));

jest.mock("@/components/admin/user-table", () => ({
  UserTable: ({
    users,
    onEdit,
  }: {
    users: Array<{ id: number; username: string }>;
    onEdit?: (u: never) => void;
  }) => (
    <div>
      {users.map((u) => (
        <button key={u.id} type="button" onClick={() => onEdit?.(u as never)}>
          {`Edit ${u.username}`}
        </button>
      ))}
    </div>
  ),
}));

import AdminUsersPage from "@/app/(app)/admin/users/page";

const editButton = () => screen.getByRole("button", { name: "Edit packer" });
const adminBox = () => screen.getByRole("checkbox", { name: "Admin Role" });
const dialogTitle = () => screen.queryByRole("heading", { name: "Edit User" });

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsersData = { users: [mockUser], pagination: { totalPages: 1 } };
  mockCompanies = DEFAULT_COMPANIES;
  // By default the fresh read finds the user as listed, stored now.
  mockRefetch.mockImplementation(async () => ({
    status: "success",
    data: mockUsersData,
    dataUpdatedAt: Date.now(),
  }));
});

describe("Edit User is mounted per open (MS-3-1)", () => {
  it("Admin ticked → Cancel → reopen shows it UNticked", async () => {
    const user = userEvent.setup();
    render(<AdminUsersPage />);

    await user.click(editButton());
    expect(dialogTitle()).toBeInTheDocument();
    expect(adminBox()).not.toBeChecked();

    await user.click(adminBox());
    expect(adminBox()).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogTitle()).toBeNull());

    await user.click(editButton());
    expect(adminBox()).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("the cancelled grant never rides along with a later username fix", async () => {
    const user = userEvent.setup();
    render(<AdminUsersPage />);

    await user.click(editButton());
    await user.click(adminBox());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogTitle()).toBeNull());

    await user.click(editButton());
    await user.type(screen.getByLabelText("Username"), "2");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser).toHaveBeenCalledWith({ id: 7, data: { username: "packer2" } });
    // The success close unmounts the dialog.
    await waitFor(() => expect(dialogTitle()).toBeNull());
  });

  it.each([
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    [
      "the X",
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole("button", { name: "Close" })),
    ],
  ])("a draft dismissed with %s is gone on reopen", async (_how, dismiss) => {
    const user = userEvent.setup();
    render(<AdminUsersPage />);

    await user.click(editButton());
    await user.click(adminBox());
    await user.clear(screen.getByLabelText("Username"));
    await user.type(screen.getByLabelText("Username"), "draft-name");

    await dismiss(user);
    await waitFor(() => expect(dialogTitle()).toBeNull());

    await user.click(editButton());
    expect(adminBox()).not.toBeChecked();
    expect(screen.getByLabelText("Username")).toHaveValue("packer");
  });

  it("nothing of the dialog is rendered while it is closed", async () => {
    const user = userEvent.setup();
    render(<AdminUsersPage />);

    expect(dialogTitle()).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();

    await user.click(editButton());
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
  });
});

// ===========================================================================
// FR-R1 (2), CR-OC-3: the form is seeded from a read issued AFTER the Edit tap
// ===========================================================================

describe("Edit User is seeded from a fresh read, never the list row (CR-OC-3)", () => {
  const COMPANIES_ABCD = [
    { id: "co_a", name: "Awake", slug: "awake", createdAt: "2026-01-01" },
    { id: "co_b", name: "Beta", slug: "beta", createdAt: "2026-01-01" },
    { id: "co_c", name: "Gamma", slug: "gamma", createdAt: "2026-01-01" },
    { id: "co_d", name: "Delta", slug: "delta", createdAt: "2026-01-01" },
  ];
  const withCompanies = (...ids: string[]) => ({
    ...mockUser,
    companies: ids.map((companyId) => ({
      companyId,
      companyName: COMPANIES_ABCD.find((c) => c.id === companyId)!.name,
    })),
  });

  /** The membership rows' company selects (the Default Location select excluded). */
  const membershipNames = () =>
    screen
      .getAllByRole("combobox")
      .filter((el) => el !== screen.getByRole("combobox", { name: "Default Location" }))
      .map((el) => el.textContent);

  /**
   * A fresh read the test answers by hand — stored when it answers, unless the
   * result names its own `dataUpdatedAt`.
   */
  function holdRefetch() {
    let answer!: (result: unknown) => void;
    mockRefetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    return (result: Record<string, unknown>) =>
      act(async () => answer({ dataUpdatedAt: Date.now(), ...result }));
  }

  it("a STALE list row (A, B) and a fresh read (A, B, C): the form shows A, B, C, and adding D sends [A, B, C, D]", async () => {
    const user = userEvent.setup();
    mockCompanies = COMPANIES_ABCD;
    // The list row was read before another admin granted company C.
    mockUsersData = { users: [withCompanies("co_a", "co_b")], pagination: { totalPages: 1 } };
    const fresh = { users: [withCompanies("co_a", "co_b", "co_c")], pagination: { totalPages: 1 } };
    mockRefetch.mockImplementation(async () => ({ status: "success", data: fresh, dataUpdatedAt: Date.now() }));
    render(<AdminUsersPage />);

    await user.click(editButton());
    // The read was issued by the tap.
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(membershipNames()).toEqual(["Awake", "Beta", "Gamma"]));

    await user.click(screen.getByRole("button", { name: "Add Company" }));
    expect(membershipNames()).toEqual(["Awake", "Beta", "Gamma", "Delta"]);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser).toHaveBeenCalledWith({
      id: 7,
      data: {
        companies: [
          { companyId: "co_a" },
          { companyId: "co_b" },
          { companyId: "co_c" },
          { companyId: "co_d" },
        ],
      },
    });
  });

  it("`Loading…` until the read answers — no form — then the form", async () => {
    const user = userEvent.setup();
    const answer = holdRefetch();
    render(<AdminUsersPage />);

    await user.click(editButton());
    expect(dialogTitle()).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();

    await answer({ status: "success", data: mockUsersData });
    expect(screen.getByLabelText("Username")).toHaveValue("packer");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it.each([
    ["the read failed (even with the old list still cached)", { status: "error", data: mockUsersData }],
    ["the user is gone from the fresh read", { status: "success", data: { users: [], pagination: { totalPages: 1 } } }],
  ])("%s: `Couldn't load this user.` and NO form", async (_label, result) => {
    const user = userEvent.setup();
    const answer = holdRefetch();
    render(<AdminUsersPage />);

    await user.click(editButton());
    await answer(result);
    expect(screen.getByText("Couldn't load this user.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Admin Role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
  });

  // FR-R2 (14), FD-6: the belt under the library's guarantee — an answer whose
  // data was stored BEFORE the tap did not read the user after it.
  it("a success whose data was stored BEFORE the tap: the same sentence, and NO form", async () => {
    const user = userEvent.setup();
    const answer = holdRefetch();
    const beforeTheTap = Date.now() - 1;
    render(<AdminUsersPage />);

    await user.click(editButton());
    await answer({ status: "success", data: mockUsersData, dataUpdatedAt: beforeTheTap });
    expect(screen.getByText("Couldn't load this user.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
  });

  it("a read that REJECTS: the same sentence, and no form", async () => {
    const user = userEvent.setup();
    mockRefetch.mockImplementation(async () => {
      throw new Error("offline");
    });
    render(<AdminUsersPage />);

    await user.click(editButton());
    expect(await screen.findByText("Couldn't load this user.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("a read answering after the dialog was closed opens nothing", async () => {
    const user = userEvent.setup();
    const answer = holdRefetch();
    render(<AdminUsersPage />);

    await user.click(editButton());
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialogTitle()).toBeNull());

    await answer({ status: "success", data: mockUsersData });
    expect(dialogTitle()).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });
});
