/** @jest-environment jsdom */
//
// `components/inventory/transfer-dialog.tsx` — the source cannot cover the
// transfer. § P2-B3-1R, M-b1 fix 12 (MS-1-6; the add action REMOVED, row 108).
//
// The "Not enough stock" alert's primary action used to MINT the shortfall at
// the source (an unclassified positive adjustment, not atomic with the transfer)
// and then retry. It is INVERTED here: the alert says what the source holds — or
// that it could not be read, never `?? 0` — and offers ONE way out, `Change the
// quantity`, which closes the alert and puts focus on the quantity. This dialog
// never sends an adjustment.

import * as fs from "fs";
import * as path from "path";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("@/contexts/location-context", () => {
  // Stable reference: the dialog's seed effect depends on `locations`; the real
  // context provides stable state, so the mock must not re-create the array.
  const locations = [
    { id: 2, name: "Office" },
    { id: 3, name: "Warehouse" },
  ];
  return {
    useLocation: () => ({ selectedLocationId: 2, locations }),
  };
});

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

import { toast } from "sonner";
import { TransferDialog } from "@/components/inventory/transfer-dialog";

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

/** The transfer route's flat insufficient-stock 400, with `extra` merged in. */
function insufficientBody(extra: Record<string, unknown>) {
  return {
    error: "Insufficient stock",
    code: "INVENTORY_INSUFFICIENT_STOCK",
    requestedQuantity: 5,
    shortfall: 3,
    ...extra,
  };
}

/** Answer the transfer with `transferBody` (a 400), and each location's stock read. */
function mockFetch(transferBody: Record<string, unknown>) {
  const fn = jest.fn((url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/inventory/transfer")) {
      return Promise.resolve({ ok: false, status: 400, json: async () => transferBody });
    }
    if (u.includes("/api/inventory/product/")) {
      const locationId = new URL(u, "http://test.local").searchParams.get("locationId");
      // Source (Office, id 2) has 2 units; destination (Warehouse, id 3) has 0.
      return Promise.resolve({
        ok: true,
        json: async () => ({ currentQuantity: locationId === "2" ? 2 : 0 }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** No request this dialog makes is ever an adjustment. */
const adjustCalls = (fn: jest.Mock) =>
  fn.mock.calls.filter(([url]) => String(url).includes("/api/inventory/adjust"));

const quantityField = () => screen.getByPlaceholderText("0");

/** Render, ask for 5 from Office (which holds 2), and return the alert. */
async function askForFive() {
  wrap(
    <TransferDialog open onOpenChange={() => {}} product={{ id: 42, name: "AOD 2mg" }} onSuccess={() => {}} />
  );
  // Source quantity resolves (2 units at Office) before we submit.
  expect(await screen.findAllByText(/2 units/)).not.toHaveLength(0);
  fireEvent.change(quantityField(), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: /transfer 5 units/i }));
  return screen.findByRole("alertdialog");
}

describe("the transfer's 'Not enough stock' alert (MS-1-6)", () => {
  it("says what the source holds — and offers no way to add stock", async () => {
    const fetchFn = mockFetch(insufficientBody({ currentQuantity: 2 }));
    const alert = await askForFive();

    expect(alert).toHaveTextContent("Not enough stock at source location");
    expect(alert).toHaveTextContent("Only 2 units at Office.");
    // INVERTED (`:27-69`): the auto-add offer and its numbers are gone.
    expect(alert).not.toHaveTextContent(/add missing stock/i);
    expect(alert).not.toHaveTextContent(/shortfall/i);
    expect(alert).not.toHaveTextContent(/available now/i);
    expect(alert).not.toHaveTextContent(/so you can move/i);
    expect(adjustCalls(fetchFn)).toHaveLength(0);
  });

  it("one unit is `1 unit`", async () => {
    mockFetch(insufficientBody({ currentQuantity: 1 }));
    const alert = await askForFive();

    expect(alert).toHaveTextContent("Only 1 unit at Office.");
  });

  it("an answer with no count says the stock could not be read — never 0", async () => {
    mockFetch(insufficientBody({}));
    const alert = await askForFive();

    expect(alert).toHaveTextContent("Couldn't read the stock at Office.");
    expect(alert).not.toHaveTextContent(/Only 0/);
  });

  it("has ONE button, `Change the quantity`, and it has focus when the alert opens", async () => {
    mockFetch(insufficientBody({ currentQuantity: 2 }));
    const alert = await askForFive();

    const buttons = Array.from(alert.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(/^Change the quantity$/);
    await waitFor(() => expect(buttons[0]).toHaveFocus());
  });

  it("`Change the quantity` closes the alert and focus lands on the quantity; no adjustment is ever sent", async () => {
    const user = userEvent.setup();
    const fetchFn = mockFetch(insufficientBody({ currentQuantity: 2 }));
    await askForFive();

    await user.click(screen.getByRole("button", { name: "Change the quantity" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(quantityField()).toHaveFocus());
    // The transfer dialog is still there, with the quantity to change.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(quantityField()).toHaveValue(5);
    expect(adjustCalls(fetchFn)).toHaveLength(0);
  });

  it("Escape closes the alert the same way: focus on the quantity, nothing sent", async () => {
    const user = userEvent.setup();
    const fetchFn = mockFetch(insufficientBody({ currentQuantity: 2 }));
    await askForFive();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(quantityField()).toHaveFocus());
    expect(adjustCalls(fetchFn)).toHaveLength(0);
  });
});

// The typed-state arm of MS-1-5 (the page arm is inventory-page.test.tsx): the
// page mounts this dialog per open, so a quantity typed for product A is gone
// when it mounts for product B.
it("typed on A → remount for B → empty", async () => {
  mockFetch(insufficientBody({ currentQuantity: 2 }));
  const first = wrap(
    <TransferDialog open onOpenChange={() => {}} product={{ id: 42, name: "AOD 2mg" }} />
  );
  fireEvent.change(quantityField(), { target: { value: "5" } });
  expect(quantityField()).toHaveValue(5);
  first.unmount();

  wrap(<TransferDialog open onOpenChange={() => {}} product={{ id: 43, name: "BPC 5mg" }} />);
  expect(screen.getByText("BPC 5mg")).toBeInTheDocument();
  expect(quantityField()).toHaveValue(null);
});

// The grep pin (MS-1-6): no client file sends the transfer auto-add flag. The
// server's arm stays (registered); nothing under these trees may reach it.
it("no file under components/, hooks/ or app/(app)/ contains `autoAddForTransfer`", () => {
  const root = path.resolve(__dirname, "../../..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, "utf8").includes("autoAddForTransfer")) {
        hits.push(path.relative(root, full));
      }
    }
  };
  const trees = ["components", "hooks", path.join("app", "(app)")];
  for (const tree of trees) {
    expect(fs.existsSync(path.join(root, tree))).toBe(true);
    walk(path.join(root, tree));
  }
  expect(hits).toEqual([]);
});

// ===========================================================================
// FR-R1 (1): the shared submit latch (CR-G1-1, CR-OC-7a)
//
// The hosts mount this dialog PER OPEN, and its `onOpenChange` was raw: an
// Escape while the transfer was in flight UNMOUNTED it, and a not-enough-stock
// answer then set state on nothing — no alert, no toast, and the operator
// believed the stock had moved. A double tap sent two transfers.
// ===========================================================================

describe("a transfer in flight (M-a.1)", () => {
  /** Hold the transfer POST until released; it then answers with `answer`. */
  function holdTransfer(answer: { status: number; body: Record<string, unknown> }) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory/transfer")) {
        await held;
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
      }
      if (u.includes("/api/inventory/product/")) {
        const locationId = new URL(u, "http://test.local").searchParams.get("locationId");
        return { ok: true, json: async () => ({ currentQuantity: locationId === "2" ? 2 : 0 }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fn as unknown as typeof fetch;
    return { fn, release: () => act(async () => release()) };
  }

  const transferCalls = (fn: jest.Mock) =>
    fn.mock.calls.filter(([url]) => String(url).includes("/api/inventory/transfer"));

  /** The pages' shape: rendered only while open, unmounted on close. */
  function PerOpenHost({ onOpenChange }: { onOpenChange: jest.Mock }) {
    const [open, setOpen] = React.useState(true);
    return open ? (
      <TransferDialog
        open
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
        product={{ id: 42, name: "AOD 2mg" }}
      />
    ) : null;
  }

  async function typeFive() {
    expect(await screen.findAllByText(/2 units/)).not.toHaveLength(0);
    fireEvent.change(quantityField(), { target: { value: "5" } });
  }

  it("Escape while the POST is pending does not close; the not-enough-stock alert still shows when the answer arrives", async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    const { fn, release } = holdTransfer({ status: 400, body: insufficientBody({ currentQuantity: 2 }) });
    wrap(<PerOpenHost onOpenChange={onOpenChange} />);
    await typeFive();

    await user.click(screen.getByRole("button", { name: /transfer 5 units/i }));
    await waitFor(() => expect(transferCalls(fn)).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Transferring..." })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Cancel is refused too, and the fields are frozen.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(quantityField()).toBeDisabled();

    await release();
    const alert = await screen.findByRole("alertdialog");
    expect(alert).toHaveTextContent("Only 2 units at Office.");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Escape in the instant after the tap (before any render) is dropped too", async () => {
    const onOpenChange = jest.fn();
    const { release } = holdTransfer({ status: 400, body: insufficientBody({ currentQuantity: 2 }) });
    wrap(<PerOpenHost onOpenChange={onOpenChange} />);
    await typeFive();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /transfer 5 units/i }));
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    await release();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Only 2 units at Office.");
  });

  it("a double tap sends ONE transfer", async () => {
    const onOpenChange = jest.fn();
    const { fn, release } = holdTransfer({ status: 200, body: { success: true } });
    wrap(<PerOpenHost onOpenChange={onOpenChange} />);
    await typeFive();

    // Both taps in the instant before "Transferring..." renders (FD3-1): only
    // the latch's synchronous ref can refuse the second.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /transfer 5 units/i }));
      fireEvent.click(screen.getByRole("button", { name: /transfer 5 units/i }));
    });
    await waitFor(() => expect(transferCalls(fn)).toHaveLength(1));

    await release();
    // The success closes it — once, through the host's raw callback.
    await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[false]]));
    expect(transferCalls(fn)).toHaveLength(1);
    expect(toast.success as jest.Mock).toHaveBeenCalledWith("Moved 5 units of AOD 2mg");
  });

  it("a FAILED transfer releases the latch: Transfer sends again, Cancel closes", async () => {
    const onOpenChange = jest.fn();
    const { fn, release } = holdTransfer({ status: 500, body: { error: "boom" } });
    wrap(<PerOpenHost onOpenChange={onOpenChange} />);
    await typeFive();

    fireEvent.click(screen.getByRole("button", { name: /transfer 5 units/i }));
    await release();
    await waitFor(() => expect(toast.error as jest.Mock).toHaveBeenCalledWith("boom"));
    await waitFor(() => expect(screen.getByRole("button", { name: /transfer 5 units/i })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /transfer 5 units/i }));
    await waitFor(() => expect(transferCalls(fn)).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });
});

// ===========================================================================
// FR-R1 (4): the after-transfer line is drawn only from KNOWN stock (CR-OC-2)
// ===========================================================================

describe("the after-transfer line", () => {
  type Read = number | "error" | "hang";
  /** Answer each location's stock read: a count, a failure, or never. */
  function stockReads(source: Read, destination: Read) {
    const fn = jest.fn((url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory/product/")) {
        const locationId = new URL(u, "http://test.local").searchParams.get("locationId");
        const read = locationId === "2" ? source : destination;
        if (read === "hang") return new Promise(() => {});
        if (read === "error") return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
        return Promise.resolve({ ok: true, json: async () => ({ currentQuantity: read }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fn as unknown as typeof fetch;
  }

  const afterLine = () => screen.getByRole("status");

  function renderAndType(qty: string) {
    wrap(<TransferDialog open onOpenChange={() => {}} product={{ id: 42, name: "AOD 2mg" }} />);
    fireEvent.change(quantityField(), { target: { value: qty } });
  }

  it("both reads answered: the projection from the read counts", async () => {
    stockReads(7, 4);
    renderAndType("3");
    await waitFor(() =>
      expect(afterLine()).toHaveTextContent("After transfer: Office -> 4 units | Warehouse -> 7 units"),
    );
  });

  it.each([
    ["the source still reading", "hang", 4],
    ["the destination still reading", 7, "hang"],
    ["the source read failed", "error", 4],
    ["the destination read failed", 7, "error"],
    ["both failed", "error", "error"],
  ] as Array<[string, Read, Read]>)("%s: NO projection (unknown is not 0)", async (_label, source, destination) => {
    stockReads(source, destination);
    renderAndType("3");
    // Let every read that will answer, answer, before the line is judged: a
    // count shows as its chip, a failure as the chips' failure text (the
    // source has two chips, the destination one).
    const failures = (source === "error" ? 2 : 0) + (destination === "error" ? 1 : 0);
    await waitFor(() => {
      if (typeof source === "number") expect(screen.getAllByText(`${source} units`)).toHaveLength(2);
      if (typeof destination === "number") expect(screen.getAllByText(`${destination} units`)).toHaveLength(1);
      expect(screen.queryAllByText("Could not load current stock")).toHaveLength(failures);
    });
    expect(afterLine()).toBeEmptyDOMElement();
  });
});
