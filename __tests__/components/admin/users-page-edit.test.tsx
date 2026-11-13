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
 * Now the page mounts the dialog per open and nulls `editingUser` on any close,
 * so every open is a fresh mount from the stored user.
 *
 * The REAL dialog renders here; the data hooks are stubbed, and the user list
 * hands back the SAME user object on every render (as react-query does).
 * `UserTable` is reduced to one Edit button per user (its row menu is not under
 * test).
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
const mockUsersData = { users: [mockUser], pagination: { totalPages: 1 } };
const mockPendingData = { users: [] };
const mockLocations = [{ id: 1, name: "Main" }];
const mockCompanies = [{ id: "co_a", name: "Awake", slug: "awake", createdAt: "2026-01-01" }];
const mockUpdateUser = jest.fn(async () => ({}));
const mockMutation = () => ({ mutateAsync: jest.fn(async () => ({})), isPending: false });

jest.mock("@/hooks/use-admin", () => ({
  useAdminPendingUsers: () => ({ data: mockPendingData, error: null }),
  useAdminUsers: () => ({ data: mockUsersData, isLoading: false, error: null }),
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

beforeEach(() => {
  jest.clearAllMocks();
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
