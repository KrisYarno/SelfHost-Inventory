/** @jest-environment jsdom */
/**
 * `app/(app)/admin/users/page.tsx` — Edit User's FRESH READ under a REAL
 * QueryClient and the REAL `useAdminUsers` (reconciliation Part 2, FR-R2 (14),
 * FD-6). Only `fetch` answers; every hook, the user table and the dialog are
 * the real ones (the router is stubbed because it needs the app router's
 * context — it reads no data).
 *
 * FR-R1 (2) seeds the form from a read issued AFTER the Edit tap: the page
 * calls `refetch()`. The fix-delta traced the library (`@tanstack/query-core`
 * 5.90.6): `refetch()` cancels an in-flight request and issues a new one, so a
 * read already in the air when the admin taps — begun from a STALE cache — can
 * never be the one that seeds the form. That guarantee rested on a library
 * read; this pins it end to end:
 *
 *   a stale cache, plus a held in-flight list request, then the Edit tap →
 *   a SECOND request is issued (the first is aborted), and the form shows the
 *   SECOND answer.
 *
 * The belt beside it (`dataUpdatedAt >= the tap`) is pinned with a stubbed
 * hook in `users-page-edit.test.tsx`.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

import AdminUsersPage from "@/app/(app)/admin/users/page";

const COMPANIES = [
  { id: "co_a", name: "Awake", slug: "awake", createdAt: "2026-01-01" },
  { id: "co_b", name: "Beta", slug: "beta", createdAt: "2026-01-01" },
];

const packer = (companyIds: string[]) => ({
  id: 7,
  email: "packer@example.test",
  username: "packer",
  isAdmin: false,
  isApproved: true,
  defaultLocationId: 1,
  emailAlerts: false,
  minLocationEmailAlerts: false,
  minCombinedEmailAlerts: false,
  companies: companyIds.map((companyId) => ({
    companyId,
    companyName: COMPANIES.find((c) => c.id === companyId)!.name,
  })),
});

const page = (users: unknown[]) => ({
  users,
  pagination: { page: 1, limit: 10, total: users.length, totalPages: 1 },
});

/** The list query's key for the page's first render (all users, no search, page 1). */
const LIST_KEY = ["admin", "users", "list", { filter: "all", search: "", page: 1 }];
const LIST_URL = "/api/admin/users?filter=all&page=1&limit=10&include=details";

const json = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body } as unknown as Response);

beforeAll(() => {
  // Radix DropdownMenu / Select need these in jsdom.
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

it("a stale cache + a held in-flight read, then the Edit tap: a SECOND request, and the form shows ITS answer", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // The cache the admin's list was drawn from: read a minute ago, before
  // another admin granted company B.
  queryClient.setQueryData(LIST_KEY, page([packer(["co_a"])]), { updatedAt: Date.now() - 60_000 });

  /** Every list request, with the signal it was sent under. */
  const listRequests: Array<{ signal: AbortSignal | null | undefined }> = [];
  const fetchMock = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === "/api/csrf") return json({ token: "t" });
    if (href === "/api/locations") return json([{ id: 1, name: "Main" }]);
    if (href === "/api/admin/companies") return json({ companies: COMPANIES });
    if (href.startsWith("/api/admin/users?filter=pending")) return json(page([]));
    if (href === LIST_URL) {
      listRequests.push({ signal: init?.signal });
      if (listRequests.length === 1) {
        // The FIRST read is held in flight — the mount's background refetch
        // of the stale cache. It answers only by being aborted.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        });
      }
      // The SECOND read: the user as stored now (A and B).
      return json(page([packer(["co_a", "co_b"])]));
    }
    throw new Error(`unexpected request ${href}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <QueryClientProvider client={queryClient}>
      <AdminUsersPage />
    </QueryClientProvider>,
  );

  // The stale row is on screen, and its background read is in flight.
  expect(await screen.findByText("packer")).toBeInTheDocument();
  await waitFor(() => expect(listRequests).toHaveLength(1));

  await user.click(screen.getByRole("button", { name: "Open menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit User" }));

  // The tap issued a NEW read; the held one was cancelled, not reused.
  await waitFor(() => expect(listRequests).toHaveLength(2));
  expect(listRequests[0].signal?.aborted).toBe(true);

  // The form is the SECOND answer's user: both memberships.
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByLabelText("Username")).toHaveValue("packer"));
  const memberships = within(dialog)
    .getAllByRole("combobox")
    .filter((el) => el !== within(dialog).getByRole("combobox", { name: "Default Location" }))
    .map((el) => el.textContent);
  expect(memberships).toEqual(["Awake", "Beta"]);
  expect(listRequests).toHaveLength(2);
});
