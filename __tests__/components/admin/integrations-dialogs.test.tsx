/** @jest-environment jsdom */
/**
 * `app/(app)/admin/integrations/page.tsx` — § P2-B3-1R, M-b2 fix 9 (MS-3-10,
 * MS-3-11).
 *
 * Create's `onOpenChange` only flipped the open flag; the form, the typed
 * credentials and the success panel were cleared by the Cancel/Close BUTTONS
 * alone. So:
 *   - a success panel dismissed with Escape reopened as that same panel, with
 *     the previous store's webhook secret still revealable;
 *   - credentials typed and dismissed with the X rode into the next create;
 *   - Edit shared the form and its X did not reset it, so Add opened prefilled
 *     with the edited store (and any key typed into Edit).
 * The platform also defaulted to Shopify, under which the webhook secret is
 * not required.
 *
 * Now `openCreateDialog` resets and opens; EVERY close goes through
 * `closeCreateDialog` (form, webhook URL, credentials); every Edit close clears
 * its subject and the form; the create is latched (no dismissal mid-flight);
 * the platform defaults to WooCommerce.
 *
 * Every credential here is an obvious fake.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const mockIntegrations = [
  {
    id: "int_shop",
    companyId: "co_a",
    platform: "SHOPIFY" as const,
    name: "Old Shopify Store",
    storeUrl: "https://old-shop.example.test",
    isActive: true,
    lastSyncAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    stockSyncEnabled: false,
    fulfillmentPushEnabled: false,
    lastStockSyncAt: null,
    lastStockSyncError: null,
    lastSyncError: null,
    syncLockedAt: null,
    lastWebhookReceivedAt: null,
    lastWebhookError: null,
    webhookFailureCount: 0,
    company: { name: "Awake" },
    credentials: { hasWriteCredential: true, hasReadCredential: false, hasWebhookSecret: true },
  },
];
const mockCompanies = [{ id: "co_a", name: "Awake", slug: "awake" }];
const mockCreate = jest.fn();
const mockUpdate = jest.fn(async () => ({}));
const mockMutation = () => ({ mutateAsync: jest.fn(async () => ({})), isPending: false });

jest.mock("@/hooks/use-integrations", () => ({
  ...jest.requireActual("@/hooks/use-integrations"),
  useIntegrations: () => ({ data: mockIntegrations, isLoading: false, error: null }),
  useCompanies: () => ({ data: mockCompanies, isLoading: false, error: null }),
  useCreateIntegration: () => ({ mutateAsync: mockCreate, isPending: false }),
  useUpdateIntegration: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useToggleIntegrationField: () => mockMutation(),
  useDeleteIntegration: () => mockMutation(),
  useSyncIntegration: () => mockMutation(),
  useStockSyncIntegration: () => mockMutation(),
  usePriceSyncIntegration: () => mockMutation(),
}));

import AdminIntegrationsPage from "@/app/(app)/admin/integrations/page";

type User = ReturnType<typeof userEvent.setup>;

// The create arms type a whole form into a large page (each keystroke
// re-renders it); give them headroom under a parallel run.
jest.setTimeout(15_000);

const FAKE = {
  name: "Fake Store",
  storeUrl: "https://f.example.test",
  writeKey: "ck_FAKE_W",
  writeSecret: "cs_FAKE_W",
  webhookSecret: "whsec_FAKE",
};

const createDialog = () => screen.getByRole("dialog", { name: "Create New Integration" });
const queryCreateDialog = () => screen.queryByRole("dialog", { name: "Create New Integration" });
const queryEditDialog = () => screen.queryByRole("dialog", { name: "Edit Integration" });

async function openAdd(user: User) {
  await user.click(screen.getByRole("button", { name: "Add Integration" }));
  return createDialog();
}

/** The create form's two Selects: [Company, Platform]. */
const createSelects = () => within(createDialog()).getAllByRole("combobox");

/** The create form is BLANK, on WooCommerce, with no success panel. */
function expectBlankCreateForm() {
  const dialog = createDialog();
  expect(within(dialog).queryByText("Integration Created!")).toBeNull();
  const [company, platform] = createSelects();
  expect(company).toHaveTextContent("Select a company");
  expect(platform).toHaveTextContent("WooCommerce");
  expect(within(dialog).getByLabelText("Store Name")).toHaveValue("");
  expect(within(dialog).getByLabelText("Store URL")).toHaveValue("");
  expect(within(dialog).getByLabelText("Write Consumer Key")).toHaveValue("");
  expect(within(dialog).getByLabelText("Write Consumer Secret")).toHaveValue("");
  expect(within(dialog).getByLabelText("Read Consumer Key")).toHaveValue("");
  expect(within(dialog).getByLabelText("Read Consumer Secret")).toHaveValue("");
  expect(within(dialog).getByLabelText("Webhook Secret")).toHaveValue("");
  // No fake credential survives anywhere in the dialog.
  for (const secret of Object.values(FAKE)) {
    expect(within(dialog).queryByDisplayValue(secret)).toBeNull();
  }
}

async function fillCreateForm(user: User) {
  const dialog = createDialog();
  await user.click(createSelects()[0]);
  await user.click(await screen.findByRole("option", { name: "Awake" }));
  await user.type(within(dialog).getByLabelText("Store Name"), FAKE.name);
  await user.type(within(dialog).getByLabelText("Store URL"), FAKE.storeUrl);
  await user.type(within(dialog).getByLabelText("Write Consumer Key"), FAKE.writeKey);
  await user.type(within(dialog).getByLabelText("Write Consumer Secret"), FAKE.writeSecret);
  await user.type(within(dialog).getByLabelText("Webhook Secret"), FAKE.webhookSecret);
}

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockImplementation(async () => ({ integration: { id: "int_new" } }));
});

// ===========================================================================
// CREATE: opens blank, every close clears
// ===========================================================================

describe("Add Integration opens blank; every close clears it (MS-3-10)", () => {
  it("success panel → Escape → Add opens blank", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    await openAdd(user);
    await fillCreateForm(user);
    await user.click(within(createDialog()).getByRole("button", { name: "Create Integration" }));

    expect(await within(createDialog()).findByText("Integration Created!")).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(within(createDialog()).getByDisplayValue(FAKE.webhookSecret)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(queryCreateDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();
  });

  it("success panel → the X → Add opens blank, the secret hidden again", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    await openAdd(user);
    await fillCreateForm(user);
    await user.click(within(createDialog()).getByRole("button", { name: "Create Integration" }));
    await within(createDialog()).findByText("Integration Created!");

    // Reveal the secret, then dismiss with the X (the panel has two "Close"
    // buttons: the footer's, and the X with its sr-only label).
    expect(within(createDialog()).getByDisplayValue(FAKE.webhookSecret)).toHaveAttribute("type", "password");
    await user.click(createDialog().querySelector("svg.lucide-eye")!.closest("button")!);
    expect(within(createDialog()).getByDisplayValue(FAKE.webhookSecret)).toHaveAttribute("type", "text");
    const closeButtons = within(createDialog()).getAllByRole("button", { name: "Close" });
    expect(closeButtons).toHaveLength(2);
    await user.click(closeButtons[1]);
    await waitFor(() => expect(queryCreateDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();

    // The next store's success panel starts with its secret HIDDEN.
    await fillCreateForm(user);
    await user.click(within(createDialog()).getByRole("button", { name: "Create Integration" }));
    await within(createDialog()).findByText("Integration Created!");
    expect(within(createDialog()).getByDisplayValue(FAKE.webhookSecret)).toHaveAttribute("type", "password");
  });

  it("credentials typed → X → reopen is blank", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Store Name"), FAKE.name);
    await user.type(within(dialog).getByLabelText("Write Consumer Key"), FAKE.writeKey);
    await user.type(within(dialog).getByLabelText("Webhook Secret"), FAKE.webhookSecret);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(queryCreateDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("credentials typed → Escape → reopen is blank", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Write Consumer Secret"), FAKE.writeSecret);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(queryCreateDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();
  });

  it("credentials typed → Cancel → reopen is blank", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Read Consumer Key"), "ck_FAKE_TEST_READ");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(queryCreateDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();
    expect(within(createDialog()).queryByDisplayValue("ck_FAKE_TEST_READ")).toBeNull();
  });
});

// ===========================================================================
// EDIT: every close resets the shared form
// ===========================================================================

describe("Edit's close resets the shared form (MS-3-10)", () => {
  async function openEdit(user: User) {
    const pencil = document.querySelector("svg.lucide-pencil")!.closest("button")!;
    await user.click(pencil);
    return screen.getByRole("dialog", { name: "Edit Integration" });
  }

  it("Edit (type a key) → X → Add opens blank, with WooCommerce selected", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    const edit = await openEdit(user);
    // The Shopify store's values fill the shared form.
    expect(within(edit).getByLabelText("Store Name")).toHaveValue("Old Shopify Store");
    await user.type(within(edit).getByLabelText("Admin API Access Token (write)"), "shpat_FAKE_TEST");

    await user.click(within(edit).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(queryEditDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();
    expect(within(createDialog()).queryByDisplayValue("Old Shopify Store")).toBeNull();
    expect(within(createDialog()).queryByDisplayValue("shpat_FAKE_TEST")).toBeNull();
  });

  it("Edit → Escape → Add opens blank", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    const edit = await openEdit(user);
    await user.type(within(edit).getByLabelText("Webhook Secret"), FAKE.webhookSecret);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(queryEditDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();
  });

  it("Edit still saves through the shared form and then resets it", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    const edit = await openEdit(user);
    await user.clear(within(edit).getByLabelText("Store Name"));
    await user.type(within(edit).getByLabelText("Store Name"), "Renamed Store");
    await user.click(within(edit).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "int_shop",
      body: expect.objectContaining({ name: "Renamed Store", platform: "SHOPIFY" }),
    });
    await waitFor(() => expect(queryEditDialog()).toBeNull());

    await openAdd(user);
    expectBlankCreateForm();
  });
});

// ===========================================================================
// THE DEFAULT PLATFORM (MS-3-11) and THE LATCH
// ===========================================================================

describe("the default platform is WooCommerce (MS-3-11)", () => {
  it("a fresh Add shows WooCommerce, and the webhook secret is required", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    const dialog = await openAdd(user);
    expect(createSelects()[1]).toHaveTextContent("WooCommerce");
    expect(within(dialog).getByLabelText("Webhook Secret")).toBeRequired();
  });

  it("the create sends platform WOOCOMMERCE when the platform is left alone", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AdminIntegrationsPage />);

    await openAdd(user);
    await fillCreateForm(user);
    await user.click(within(createDialog()).getByRole("button", { name: "Create Integration" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "WOOCOMMERCE", companyId: "co_a", name: FAKE.name }),
    );
  });
});

describe("the create is guarded while submitting (M-a.1)", () => {
  it("Escape and Cancel are refused mid-create; a second tap sends nothing; the fields freeze", async () => {
    const user = userEvent.setup({ delay: null });
    let release!: () => void;
    mockCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ integration: { id: "int_new" } });
        }),
    );
    render(<AdminIntegrationsPage />);

    await openAdd(user);
    await fillCreateForm(user);
    const submit = within(createDialog()).getByRole("button", { name: "Create Integration" });
    await user.click(submit);

    await waitFor(() =>
      expect(within(createDialog()).getByRole("button", { name: "Creating..." })).toBeDisabled(),
    );
    expect(within(createDialog()).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(createDialog()).getByLabelText("Store Name")).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(queryCreateDialog()).toBeInTheDocument();
    // The X is refused too.
    await user.click(within(createDialog()).getByRole("button", { name: "Close" }));
    expect(queryCreateDialog()).toBeInTheDocument();
    // A second submit reaching the handler (the latch, not the disabled
    // button) sends nothing.
    fireEvent.submit(within(createDialog()).getByLabelText("Store Name").closest("form")!);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    release();
    expect(await within(createDialog()).findByText("Integration Created!")).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("a failed create stays open with the form intact, and can be sent again", async () => {
    const user = userEvent.setup({ delay: null });
    mockCreate.mockImplementationOnce(async () => {
      throw new Error("Store URL unreachable");
    });
    render(<AdminIntegrationsPage />);

    await openAdd(user);
    await fillCreateForm(user);
    await user.click(within(createDialog()).getByRole("button", { name: "Create Integration" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const { toast } = jest.requireMock("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Store URL unreachable"));
    expect(within(createDialog()).getByLabelText("Store Name")).toHaveValue(FAKE.name);
    expect(within(createDialog()).queryByText("Integration Created!")).toBeNull();

    await user.click(within(createDialog()).getByRole("button", { name: "Create Integration" }));
    expect(await within(createDialog()).findByText("Integration Created!")).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
