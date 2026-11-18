/** @jest-environment jsdom */
//
// Facelift F0-6 (plan 2026-11-17-facelift-f0, F0-6 + the REV 2 folds) — global
// search goes where it found something, and says when it failed.
//
// Before: every product result linked to the unfiltered `/products`, so the
// search found the product and then dropped the user on page 1 of the whole
// catalogue. A FAILED search showed "No results found", which reads as an
// answer. The spinner sat under the dialog's close button.

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush, replace: jest.fn() }) }));

import { GlobalSearch } from "@/components/layout/global-search";

let failing = false;
let fetchMock: jest.Mock;
beforeEach(() => {
  failing = false;
  mockPush.mockReset();
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname !== "/api/products") throw new Error(`unexpected fetch ${url.pathname}`);
    if (failing) return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
    return {
      ok: true,
      json: async () => ({ products: [{ id: 7, name: "Widget A & B", sku: "W-1" }] }),
    } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderOpen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GlobalSearch />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search (Cmd+K)" }));
}

const input = () => screen.getByPlaceholderText("Search products...");

describe("F0-6 — global search", () => {
  it("a product result goes to `/products?search=<encoded name>`", async () => {
    renderOpen();
    fireEvent.change(input(), { target: { value: "widget" } });
    fireEvent.click(await screen.findByText("Widget A & B"));
    expect(mockPush).toHaveBeenCalledWith(`/products?search=${encodeURIComponent("Widget A & B")}`);
    expect(mockPush).toHaveBeenCalledWith("/products?search=Widget%20A%20%26%20B");
  });

  it("a failed search reads `Search unavailable — try again.` with Retry, never `No results`", async () => {
    failing = true;
    renderOpen();
    fireEvent.change(input(), { target: { value: "widget" } });

    expect(await screen.findByText("Search unavailable — try again.")).toBeInTheDocument();
    expect(screen.queryByText(/No results/)).toBeNull();

    failing = false;
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
    expect(await screen.findByText("Widget A & B")).toBeInTheDocument();
    expect(screen.queryByText("Search unavailable — try again.")).toBeNull();
  });

  it("a successful empty answer still reads `No results found`", async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ products: [] }) }) as Response);
    renderOpen();
    fireEvent.change(input(), { target: { value: "zzz" } });
    expect(await screen.findByText(/No results found for/)).toBeInTheDocument();
    expect(screen.queryByText("Search unavailable — try again.")).toBeNull();
  });

  it("the input row carries `pr-10`, so the spinner and text clear the close button", () => {
    renderOpen();
    expect(input().parentElement).toHaveClass("pr-10");
  });
});
