/** @jest-environment jsdom */
/**
 * `components/admin/edit-user-dialog.tsx` — § P2-B3-1R, M-b2 fix 2 (MS-3-1,
 * MS-3-2, MS-3-4). The page arm (mount per open) is `users-page-edit.test.tsx`.
 *
 * The dialog used to send EVERY field on Save. So an Admin box ticked in a
 * cancelled draft rode along with a later username fix (MS-3-1); a user with no
 * default location was silently given location 1 (MS-3-2); and a stored
 * `emailAlerts: null` was sent as `false`, which the route's `!==` recorded as a
 * phantom USER_UPDATE (MS-3-4).
 *
 * Now the dialog snapshots its normalised initial values at mount and the PATCH
 * body carries ONLY the fields that differ from that snapshot:
 *   - memberships compare as a SET of company ids; when it differs, the full new
 *     list is sent;
 *   - a default location is sent only once one is picked and it differs (`Not
 *     set` is the Select's placeholder and is never sent);
 *   - nothing differs → Save is disabled and no request is sent.
 *
 * The real `useUpdateUser` runs against a mocked `fetch`, so the pins read the
 * body exactly as it would leave the browser.
 */

import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

import { EditUserDialog } from "@/components/admin/edit-user-dialog";

const LOCATIONS = [
  { id: 1, name: "Main" },
  { id: 2, name: "Office" },
];
const COMPANIES = [
  { id: "co_a", name: "Awake", slug: "awake" },
  { id: "co_b", name: "Beta", slug: "beta" },
];

type TestUser = React.ComponentProps<typeof EditUserDialog>["user"];

const baseUser = (overrides: Partial<TestUser> = {}): TestUser => ({
  id: 7,
  email: "packer@example.test",
  username: "packer",
  isAdmin: false,
  isApproved: true,
  defaultLocationId: 2,
  emailAlerts: false,
  minLocationEmailAlerts: false,
  minCombinedEmailAlerts: true,
  companies: [{ companyId: "co_a", companyName: "Awake" }],
  ...overrides,
});

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ message: "User updated successfully", user: {} }),
  })) as unknown as typeof fetch;
});

/** The PATCHes sent, with their parsed bodies. */
const patches = () =>
  (global.fetch as jest.Mock).mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));

function renderDialog(user: TestUser = baseUser()) {
  const onOpenChange = jest.fn();
  const onSuccess = jest.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <EditUserDialog
        user={user}
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        locations={LOCATIONS}
        companies={COMPANIES}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onSuccess };
}

const saveButton = () => screen.getByRole("button", { name: "Save Changes" });
const usernameField = () => screen.getByLabelText("Username");
const locationSelect = () => screen.getByRole("combobox", { name: "Default Location" });
/** The membership rows' company selects (the Default Location select excluded). */
const companySelects = () =>
  screen.getAllByRole("combobox").filter((el) => el !== locationSelect());

async function pickLocation(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(locationSelect());
  await user.click(await screen.findByRole("option", { name }));
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(saveButton());
  await waitFor(() => expect(patches()).toHaveLength(1));
  return patches()[0];
}

// ===========================================================================
// THE BODY: only what changed
// ===========================================================================

describe("the PATCH body carries ONLY the fields that changed", () => {
  it("a username-only edit sends exactly { username }", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onSuccess } = renderDialog();

    await user.clear(usernameField());
    await user.type(usernameField(), "packer2");
    const sent = await save(user);

    expect(sent.url).toBe("/api/admin/users/7");
    expect(sent.body).toEqual({ username: "packer2" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSuccess).toHaveBeenCalled();
  });

  it("an admin's username fix never re-sends isAdmin (the route's self-demotion check stays out of it)", async () => {
    const user = userEvent.setup();
    renderDialog(baseUser({ isAdmin: true }));

    await user.type(usernameField(), "-x");
    const sent = await save(user);

    expect(sent.body).toEqual({ username: "packer-x" });
    expect(sent.body).not.toHaveProperty("isAdmin");
  });

  it("ticking Admin sends exactly { isAdmin: true }", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("checkbox", { name: "Admin Role" }));
    const sent = await save(user);

    expect(sent.body).toEqual({ isAdmin: true });
  });

  it("each alert flag is sent only when it changed", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("checkbox", { name: "Combined Email Alerts" }));
    const sent = await save(user);

    expect(sent.body).toEqual({ minCombinedEmailAlerts: false });
  });
});

// ===========================================================================
// AN EMPTY DIFF: Save disabled, no request
// ===========================================================================

describe("nothing changed → Save is disabled and no request is sent", () => {
  it("a freshly opened dialog has Save disabled", () => {
    renderDialog();
    expect(saveButton()).toBeDisabled();
  });

  it("a stored emailAlerts: null, untouched, leaves Save disabled (no phantom USER_UPDATE)", () => {
    renderDialog(baseUser({ emailAlerts: null }));

    expect(screen.getByRole("checkbox", { name: "Email Alerts" })).not.toBeChecked();
    expect(saveButton()).toBeDisabled();

    // Even a forced submit (Enter in a field) sends nothing.
    fireEvent.submit(usernameField().closest("form")!);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("a stored emailAlerts: null, ticked, sends { emailAlerts: true }; ticked and unticked is no change", async () => {
    const user = userEvent.setup();
    renderDialog(baseUser({ emailAlerts: null }));
    const box = screen.getByRole("checkbox", { name: "Email Alerts" });

    await user.click(box);
    expect(saveButton()).toBeEnabled();
    await user.click(box);
    expect(saveButton()).toBeDisabled();

    await user.click(box);
    const sent = await save(user);
    expect(sent.body).toEqual({ emailAlerts: true });
  });

  it("an edit undone by hand is no change", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(usernameField(), "x");
    expect(saveButton()).toBeEnabled();
    await user.type(usernameField(), "{Backspace}");
    expect(saveButton()).toBeDisabled();
  });
});

// ===========================================================================
// THE DEFAULT LOCATION (MS-3-2)
// ===========================================================================

describe("the default location", () => {
  it.each([
    ["null", null],
    ["absent", undefined],
  ])("a %s default location shows `Not set` and is never sent as 1", async (_label, stored) => {
    const user = userEvent.setup();
    renderDialog(baseUser({ defaultLocationId: stored }));

    expect(locationSelect()).toHaveTextContent("Not set");

    await user.type(usernameField(), "2");
    const sent = await save(user);

    expect(sent.body).toEqual({ username: "packer2" });
    expect(sent.body).not.toHaveProperty("defaultLocationId");
  });

  it("from `Not set`, a location the admin picks IS sent", async () => {
    const user = userEvent.setup();
    renderDialog(baseUser({ defaultLocationId: null }));

    await pickLocation(user, "Main");
    const sent = await save(user);

    expect(sent.body).toEqual({ defaultLocationId: 1 });
  });

  it("a stored location, untouched, is not sent; a changed one is", async () => {
    const user = userEvent.setup();
    renderDialog(baseUser({ defaultLocationId: 2 }));

    expect(locationSelect()).toHaveTextContent("Office");
    await pickLocation(user, "Main");
    expect(saveButton()).toBeEnabled();
    await pickLocation(user, "Office");
    expect(saveButton()).toBeDisabled();

    await pickLocation(user, "Main");
    const sent = await save(user);
    expect(sent.body).toEqual({ defaultLocationId: 1 });
  });
});

// ===========================================================================
// MEMBERSHIPS: a set of company ids; the full list when it differs
// ===========================================================================

describe("memberships", () => {
  it("removed and re-added is the same set: no change", async () => {
    const user = userEvent.setup();
    renderDialog();

    const row = companySelects()[0].parentElement!;
    const trash = within(row).getAllByRole("button").find((b) => b !== companySelects()[0])!;
    await user.click(trash);
    expect(screen.getByText(/No company associations/)).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    // Add Company takes the first company not yet associated: Awake again.
    await user.click(screen.getByRole("button", { name: "Add Company" }));
    expect(companySelects()[0]).toHaveTextContent("Awake");
    expect(saveButton()).toBeDisabled();
  });

  it("a different set sends the FULL new list", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Company" }));
    const sent = await save(user);

    expect(sent.body).toEqual({ companies: [{ companyId: "co_a" }, { companyId: "co_b" }] });
  });

  it("a changed company sends the full new list, and nothing else", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(companySelects()[0]);
    await user.click(await screen.findByRole("option", { name: "Beta" }));
    const sent = await save(user);

    expect(sent.body).toEqual({ companies: [{ companyId: "co_b" }] });
  });

  it("removing every membership sends an empty list", async () => {
    const user = userEvent.setup();
    renderDialog();

    const row = companySelects()[0].parentElement!;
    const trash = within(row).getAllByRole("button").find((b) => b !== companySelects()[0])!;
    await user.click(trash);
    const sent = await save(user);

    expect(sent.body).toEqual({ companies: [] });
  });
});

// ===========================================================================
// FR-R1 (2): the read states, and the submit latch (CR-OC-3)
// ===========================================================================

describe("before the fresh read answers, there is no form", () => {
  function renderWithoutUser(readFailed?: boolean) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <EditUserDialog
          user={null}
          readFailed={readFailed}
          open
          onOpenChange={jest.fn()}
          onSuccess={jest.fn()}
          locations={LOCATIONS}
          companies={COMPANIES}
        />
      </QueryClientProvider>,
    );
  }

  it("in flight: `Loading…`, and no field, no Save", () => {
    renderWithoutUser();
    expect(screen.getByRole("heading", { name: "Edit User" })).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
  });

  it("failed: `Couldn't load this user.`, and no field, no Save", () => {
    renderWithoutUser(true);
    expect(screen.getByText("Couldn't load this user.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
  });
});

describe("a save in flight: one PATCH, and no dismissal (M-a.1)", () => {
  /** Hold every PATCH until the returned release is called. */
  function holdPatch() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") await held;
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: "User updated successfully", user: {} }),
      };
    }) as unknown as typeof fetch;
    return () => act(async () => release());
  }

  it("a double Enter sends ONE PATCH", async () => {
    const release = holdPatch();
    const { onOpenChange } = renderDialog();
    fireEvent.change(usernameField(), { target: { value: "packer2" } });

    // Both submits in the instant before any render: only the latch's
    // synchronous ref can refuse the second.
    act(() => {
      fireEvent.submit(usernameField().closest("form")!);
      fireEvent.submit(usernameField().closest("form")!);
    });
    await waitFor(() => expect(patches()).toHaveLength(1));

    await release();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(patches()).toHaveLength(1);
  });

  it("a double tap on Save sends ONE PATCH", async () => {
    const release = holdPatch();
    renderDialog();
    fireEvent.change(usernameField(), { target: { value: "packer2" } });

    act(() => {
      fireEvent.click(saveButton());
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(patches()).toHaveLength(1));
    await release();
    expect(patches()).toHaveLength(1);
  });

  it("Escape and Cancel mid-write do not close; the answer does, once, through the raw callback", async () => {
    const user = userEvent.setup();
    const release = holdPatch();
    const { onOpenChange, onSuccess } = renderDialog();

    await user.type(usernameField(), "2");
    await user.click(saveButton());
    await waitFor(() => expect(patches()).toHaveLength(1));

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    // The whole form is frozen while it is in flight.
    expect(usernameField()).toBeDisabled();

    await release();
    await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[false]]));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
