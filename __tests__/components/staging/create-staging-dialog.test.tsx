/** @jest-environment jsdom */
/**
 * W2.5 — the CreateStagingDialog as the receiving ENTRY POINT.
 *
 * The as-built defect this pins shut: a box could only ever be created here,
 * with no shipment field at all, so attributing it to a receipt meant leaving
 * the page, opening the receiving detail, and finding the box again in a link
 * picker. The connecting step was hidden at the END of a cross-page loop, and
 * the W1 adoption gate rides on operators actually walking it.
 *
 * What is pinned:
 *   - the shipment choice is OPTIONAL and defaults to NONE on /pre-staging —
 *     an unattributed box stays a legal thing to log;
 *   - only OPEN headers are offered (the only status the link PATCH accepts);
 *   - choosing one composes TWO requests in ONE order: create the box, THEN
 *     link it, and the link carries the id the create returned;
 *   - "New shipment…" opens the header FIRST, so a failure there leaves nothing
 *     behind, and the box then lands on it;
 *   - a LINK failure after a successful create is TRUTHFUL: the box exists,
 *     unlinked, and the dialog says exactly that and points at the queue. It
 *     never pretends to roll back — the API has no such call;
 *   - opened FROM a receiving header the choice is PREFILLED and LOCKED.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
}));
const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: jest.fn(),
  },
}));

import { CreateStagingDialog } from "@/components/staging/create-staging-dialog";

// Radix Select portals its options and drives them through pointer capture,
// neither of which jsdom implements.
beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

const SHIP_A = "ckship0000000000000000aaa";
const SHIP_B = "ckship0000000000000000bbb";
const NEW_SHIP = "ckship0000000000000000new";
const NEW_ITEM_ID = 77;

function summary(over: Record<string, unknown> = {}) {
  return {
    id: SHIP_A,
    supplierRef: "PO-1001",
    status: "OPEN",
    notes: null,
    createdBy: 7,
    closedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    creator: { id: 7, username: "kris" },
    itemCount: 0,
    receivedItemCount: 0,
    graduatedItemCount: 0,
    uncountedReceivedItemCount: 0,
    discrepancy: {
      itemCount: 0,
      countedItemCount: 0,
      uncountedItemCount: 0,
      discrepancyItemCount: 0,
      totalOver: 0,
      totalUnder: 0,
    },
    ...over,
  };
}

type Responder = (url: string, init?: RequestInit) => unknown | undefined;

function mockFetch(extra?: Responder) {
  const fn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const override = extra?.(u, init);
    if (override !== undefined) return override as Response;

    if (u.includes("/api/locations")) {
      return { ok: true, json: async () => [{ id: 1, name: "Main" }] } as unknown as Response;
    }
    if (u.includes("/api/inbound-shipments")) {
      if (init?.method === "POST") {
        return {
          ok: true,
          json: async () => summary({ id: NEW_SHIP, supplierRef: "PO-NEW" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          shipments: [summary(), summary({ id: SHIP_B, supplierRef: null })],
        }),
      } as unknown as Response;
    }
    if (u.includes("/api/staging-items")) {
      if (init?.method === "PATCH") {
        return { ok: true, json: async () => ({ id: NEW_ITEM_ID }) } as unknown as Response;
      }
      if (init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ id: NEW_ITEM_ID, description: "Box of vials" }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof CreateStagingDialog>> = {},
  extra?: Responder,
) {
  const fetchFn = mockFetch(extra);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <CreateStagingDialog open onOpenChange={jest.fn()} {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, fetchFn };
}

/** Every write, in the order it left the browser. */
const writes = (fn: jest.Mock) =>
  fn.mock.calls
    .filter((c) => (c[1] as RequestInit)?.method !== undefined)
    .map((c) => ({
      url: String(c[0]),
      method: (c[1] as RequestInit).method,
      body: (c[1] as RequestInit).body ? JSON.parse(String((c[1] as RequestInit).body)) : null,
    }));

const shipmentSelect = () => screen.getByRole("combobox", { name: /receiving shipment/i });

async function chooseShipment(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(shipmentSelect());
  await user.click(await screen.findByRole("option", { name }));
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/description/i), "Box of vials");
  await user.click(screen.getByRole("button", { name: /log item/i }));
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// PIN 1 — the choice exists, defaults to none, and lists only OPEN headers
// ---------------------------------------------------------------------------

describe("the receiving-shipment choice (from /pre-staging)", () => {
  it("offers the choice and defaults to NONE", async () => {
    renderDialog();

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    expect(shipmentSelect()).toHaveTextContent(/none/i);
  });

  it("lists only OPEN headers — the only status the link accepts", async () => {
    const { fetchFn } = renderDialog();

    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some((c) => String(c[0]).includes("/api/inbound-shipments?status=OPEN")),
      ).toBe(true),
    );
  });

  it("logs an UNATTRIBUTED box with no link request at all", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog();

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await fillAndSubmit(user);

    await waitFor(() => expect(writes(fetchFn).length).toBe(1));
    expect(writes(fetchFn)[0].method).toBe("POST");
    expect(writes(fetchFn)[0].url).toContain("/api/staging-items");
    expect(writes(fetchFn)[0].body).not.toHaveProperty("shipmentId");
  });

  it("CREATES THEN LINKS — two calls, that order, the link carrying the new id", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog();

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /PO-1001/);
    await fillAndSubmit(user);

    await waitFor(() => expect(writes(fetchFn).length).toBe(2));
    const [create, link] = writes(fetchFn);
    // The create route has no shipment column — the box is born unattributed.
    expect(create.method).toBe("POST");
    expect(create.url).toContain("/api/staging-items");
    expect(create.body).not.toHaveProperty("shipmentId");
    // …and the SECOND request is the existing link PATCH, on the returned id.
    expect(link.method).toBe("PATCH");
    expect(link.url).toContain(`/api/staging-items/${NEW_ITEM_ID}`);
    expect(link.body).toEqual({ shipmentId: SHIP_A });
  });

  it("names a header with no supplier ref by a short id rather than nothing", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await user.click(shipmentSelect());
    expect(await screen.findByRole("option", { name: /000bbb/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PIN 2 — the inline "New shipment…" path
// ---------------------------------------------------------------------------

describe("the inline new-shipment path", () => {
  it("opens the header FIRST, then creates the box, then links it", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog();

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /new shipment/i);
    await user.type(screen.getByLabelText(/supplier reference/i), "PO-NEW");
    await fillAndSubmit(user);

    await waitFor(() => expect(writes(fetchFn).length).toBe(3));
    const [header, create, link] = writes(fetchFn);
    expect(header.method).toBe("POST");
    expect(header.url).toContain("/api/inbound-shipments");
    expect(header.body).toEqual({ supplierRef: "PO-NEW" });
    expect(create.url).toContain("/api/staging-items");
    expect(link.method).toBe("PATCH");
    expect(link.body).toEqual({ shipmentId: NEW_SHIP });
  });

  it("writes NOTHING else when opening the header fails", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog({}, (url, init) => {
      if (url.includes("/api/inbound-shipments") && init?.method === "POST") {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      return undefined;
    });

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /new shipment/i);
    await fillAndSubmit(user);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // No box was logged: the header comes first precisely so this is clean.
    expect(writes(fetchFn).filter((w) => w.url.includes("/api/staging-items"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PIN 3 — a link that fails AFTER the box exists
// ---------------------------------------------------------------------------

describe("a link failure after a successful create", () => {
  const refuseLink: Responder = (url, init) => {
    if (url.includes("/api/staging-items/") && init?.method === "PATCH") {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: "Inbound shipment is not open and cannot be changed",
          code: "CONFLICT",
        }),
      };
    }
    return undefined;
  };

  it("says the box EXISTS and is UNLINKED, and surfaces the server's sentence", async () => {
    const user = userEvent.setup();
    renderDialog({}, refuseLink);

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /PO-1001/);
    await fillAndSubmit(user);

    const panel = await screen.findByTestId("staging-link-failed");
    expect(panel).toHaveTextContent(/unlinked/i);
    expect(panel).toHaveTextContent(/Box of vials/);
    expect(panel).toHaveTextContent(/not open and cannot be changed/i);
  });

  it("points at the queue where the box now sits", async () => {
    const user = userEvent.setup();
    renderDialog({}, refuseLink);

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /PO-1001/);
    await fillAndSubmit(user);

    const panel = await screen.findByTestId("staging-link-failed");
    expect(panel.querySelector('a[href="/pre-staging"]')).not.toBeNull();
  });

  it("never pretends to roll back — no delete, no second create", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog({}, refuseLink);

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /PO-1001/);
    await fillAndSubmit(user);

    await screen.findByTestId("staging-link-failed");
    const sent = writes(fetchFn);
    expect(sent.filter((w) => w.method === "DELETE")).toHaveLength(0);
    expect(sent.filter((w) => w.method === "POST" && w.url.endsWith("/api/staging-items")))
      .toHaveLength(1);
    expect(sent.some((w) => w.url.includes("/discard"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W25-1 PIN 1 + PIN 2 — an inline header that OUTLIVES the step that failed
// ---------------------------------------------------------------------------
//
// The as-built hole: "New shipment…" opened a header, the box create then
// failed, and the only word about it was a toast reading "Failed to log item".
// The choice stayed on `__new__`, so the operator's obvious next move — press
// the button again — minted a SECOND empty header. Repeat until he gave up, and
// receiving is left holding a row of orphans nobody can explain.

describe("an inline header survives a failure in the step after it", () => {
  /** POST /api/staging-items fails `times` times, then behaves. */
  function flakyBoxCreate(times: number) {
    let seen = 0;
    const responder: Responder = (url, init) => {
      if (url.endsWith("/api/staging-items") && init?.method === "POST") {
        seen += 1;
        if (seen <= times) {
          return { ok: false, status: 500, json: async () => ({ error: "Box create exploded" }) };
        }
      }
      return undefined;
    };
    return responder;
  }

  it("KEEPS the created header as the choice and NAMES it on screen", async () => {
    const user = userEvent.setup();
    renderDialog({}, flakyBoxCreate(1));

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /new shipment/i);
    await user.type(screen.getByLabelText(/supplier reference/i), "PO-NEW");
    await fillAndSubmit(user);

    // The header EXISTS. Saying so is the whole point — a toast about the box
    // leaves the operator with no idea a receipt was opened in his name.
    const notice = await screen.findByTestId("staging-created-shipment");
    expect(notice).toHaveTextContent(/PO-NEW/);
    expect(notice).toHaveTextContent(/created/i);
    expect(notice).toHaveTextContent(/open/i);

    // …and the choice has stopped meaning "make me one": it is now a plain
    // selection of that header, which is what makes the retry safe.
    await waitFor(() => expect(shipmentSelect()).toHaveTextContent(/PO-NEW/));
    expect(screen.queryByLabelText(/supplier reference/i)).not.toBeInTheDocument();
  });

  it("RETRIES against it — one header total, and the link carries its id", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog({}, flakyBoxCreate(1));

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /new shipment/i);
    await fillAndSubmit(user);
    await screen.findByTestId("staging-created-shipment");

    await user.click(screen.getByRole("button", { name: /log item/i }));

    await waitFor(() =>
      expect(writes(fetchFn).filter((w) => w.method === "PATCH")).toHaveLength(1),
    );
    const sent = writes(fetchFn);
    // ONE header, for two submissions.
    expect(sent.filter((w) => w.url.endsWith("/api/inbound-shipments"))).toHaveLength(1);
    expect(sent.filter((w) => w.url.endsWith("/api/staging-items"))).toHaveLength(2);
    expect(sent.find((w) => w.method === "PATCH")?.body).toEqual({ shipmentId: NEW_SHIP });
  });

  it("names the created header on the LINK-failure screen too", async () => {
    const user = userEvent.setup();
    renderDialog({}, (url, init) => {
      if (url.includes("/api/staging-items/") && init?.method === "PATCH") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Inbound shipment is not open", code: "CONFLICT" }),
        };
      }
      return undefined;
    });

    await waitFor(() => expect(shipmentSelect()).toBeInTheDocument());
    await chooseShipment(user, /new shipment/i);
    await fillAndSubmit(user);

    const panel = await screen.findByTestId("staging-link-failed");
    expect(panel).toHaveTextContent(/PO-NEW/);
  });
});

// ---------------------------------------------------------------------------
// W25-3 PIN 7 + PIN 8 — a failed list read is NOT an empty list
// ---------------------------------------------------------------------------

describe("the open-shipment list as a fallible read", () => {
  const failList: Responder = (url, init) => {
    if (url.includes("/api/inbound-shipments") && init?.method === undefined) {
      return { ok: false, status: 503, json: async () => ({ error: "Database is unavailable" }) };
    }
    return undefined;
  };

  it("says the list FAILED, in the server's words, with a way to try again", async () => {
    renderDialog({}, failList);

    const failure = await screen.findByTestId("staging-shipment-list-error");
    expect(failure).toHaveTextContent(/couldn.t load shipments/i);
    expect(failure).toHaveTextContent(/Database is unavailable/);
    expect(within(failure).getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // NOT the empty copy: "none exist" and "we could not ask" are different facts.
    expect(screen.queryByText(/no open shipments yet/i)).not.toBeInTheDocument();
  });

  it("still logs a box — a failed list must never block the operator", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog({}, failList);

    await screen.findByTestId("staging-shipment-list-error");
    await user.click(shipmentSelect());
    expect(await screen.findByRole("option", { name: /none/i })).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /new shipment/i }));
    await fillAndSubmit(user);

    await waitFor(() => expect(writes(fetchFn).length).toBe(3));
    const [header, create, link] = writes(fetchFn);
    expect(header.url).toContain("/api/inbound-shipments");
    expect(create.url).toContain("/api/staging-items");
    expect(link.body).toEqual({ shipmentId: NEW_SHIP });
  });

  it("says an EMPTY list is empty, without the failure styling", async () => {
    renderDialog({}, (url, init) => {
      if (url.includes("/api/inbound-shipments") && init?.method === undefined) {
        return { ok: true, json: async () => ({ shipments: [] }) };
      }
      return undefined;
    });

    expect(await screen.findByText(/no open shipments yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("staging-shipment-list-error")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PIN 5 (dialog half) — opened FROM a receiving header
// ---------------------------------------------------------------------------

describe("opened from a receiving header", () => {
  it("PREFILLS and LOCKS the shipment — no choice on offer", async () => {
    renderDialog({ lockedShipmentId: SHIP_A, lockedShipmentLabel: "PO-1001" });

    expect(await screen.findByTestId("staging-locked-shipment")).toHaveTextContent("PO-1001");
    expect(screen.queryByRole("combobox", { name: /receiving shipment/i })).not.toBeInTheDocument();
  });

  it("lands the created box on THAT header", async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderDialog({
      lockedShipmentId: SHIP_A,
      lockedShipmentLabel: "PO-1001",
    });

    await screen.findByTestId("staging-locked-shipment");
    await fillAndSubmit(user);

    await waitFor(() => expect(writes(fetchFn).length).toBe(2));
    const [create, link] = writes(fetchFn);
    expect(create.method).toBe("POST");
    expect(link.method).toBe("PATCH");
    expect(link.body).toEqual({ shipmentId: SHIP_A });
    // A locked dialog never asks for the header list it cannot use.
    expect(
      fetchFn.mock.calls.some((c) => String(c[0]).includes("/api/inbound-shipments?status=OPEN")),
    ).toBe(false);
  });
});
