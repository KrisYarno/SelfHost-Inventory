/** @jest-environment jsdom */
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScratchpadBoard from "@/components/scratchpad/scratchpad-board";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "test-csrf" }),
}));

// Route fetch by URL. The board + labels start empty; product search returns one product.
function installFetch() {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.startsWith("/api/scratchpad/labels")) {
      return { ok: true, json: async () => ({ labels: [] }) } as unknown as Response;
    }
    if (u.startsWith("/api/scratchpad")) {
      return { ok: true, json: async () => ({ board: [] }) } as unknown as Response;
    }
    if (u.startsWith("/api/products")) {
      return {
        ok: true,
        json: async () => ({
          products: [{ id: 7, name: "BPC-157 5mg", baseName: "BPC-157", variant: "5mg" }],
        }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.clearAllMocks();
});

it("renders the empty-board state when no products have rows", async () => {
  installFetch();
  render(<ScratchpadBoard />);
  await waitFor(() =>
    expect(screen.getByText(/no rough prices yet/i)).toBeInTheDocument(),
  );
});

it("a poll/refetch does NOT drop an open local (unsaved) card", async () => {
  installFetch();
  const user = userEvent.setup();
  render(<ScratchpadBoard />);

  // Wait for the initial empty board.
  await waitFor(() =>
    expect(screen.getByText(/no rough prices yet/i)).toBeInTheDocument(),
  );

  // Add a product via search -> creates a local, unsaved card and sets the editing flag.
  await user.type(
    screen.getByPlaceholderText(/add a product to the board/i),
    "bpc",
  );
  const result = await screen.findByRole("button", { name: /BPC-157 5mg/i });
  await user.click(result);

  // The local card is now rendered (header shows the product name).
  await waitFor(() =>
    expect(screen.getByText("BPC-157 5mg")).toBeInTheDocument(),
  );

  // Trigger a poll/refetch (window focus). Because an unsaved local card is open,
  // the board fetch must be paused and the local card must survive.
  await act(async () => {
    fireEvent(window, new Event("focus"));
    await Promise.resolve();
  });

  expect(screen.getByText("BPC-157 5mg")).toBeInTheDocument();
  expect(screen.queryByText(/no rough prices yet/i)).not.toBeInTheDocument();
});
