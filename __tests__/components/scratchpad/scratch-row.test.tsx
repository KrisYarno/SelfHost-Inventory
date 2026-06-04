/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScratchRow from "@/components/scratchpad/scratch-row";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "test-csrf" }),
}));

afterEach(() => {
  jest.clearAllMocks();
});

it("shows a conflict prompt and refetches on a 409", async () => {
  global.fetch = jest.fn(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ currentVersion: 5, expectedVersion: 2 }),
  })) as unknown as typeof fetch;
  const onChanged = jest.fn();
  render(
    <ScratchRow
      row={{ id: 1, label: "Awake Price", value: "40", note: null, version: 2 }}
      onChanged={onChanged}
      onActivity={() => {}}
    />,
  );
  await userEvent.click(screen.getByText("40")); // enter edit
  await userEvent.clear(screen.getByDisplayValue("40"));
  await userEvent.type(screen.getByRole("textbox"), "45");
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  await waitFor(() =>
    expect(screen.getByText(/changed this|conflict/i)).toBeInTheDocument(),
  );
  expect(onChanged).toHaveBeenCalled(); // refetch triggered (E3)
});

it("PATCHes the value field with the expected version and calls onChanged on success", async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 1, label: "Awake Price", value: "45", note: null, version: 3 }),
  })) as unknown as jest.Mock;
  global.fetch = fetchMock as unknown as typeof fetch;
  const onChanged = jest.fn();
  render(
    <ScratchRow
      row={{ id: 1, label: "Awake Price", value: "40", note: null, version: 2 }}
      onChanged={onChanged}
      onActivity={() => {}}
    />,
  );
  await userEvent.click(screen.getByText("40"));
  await userEvent.clear(screen.getByDisplayValue("40"));
  await userEvent.type(screen.getByRole("textbox"), "45");
  await userEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe("/api/scratchpad/1");
  expect(init.method).toBe("PATCH");
  const body = JSON.parse(init.body as string);
  expect(body).toMatchObject({ expectedVersion: 2, value: "45" });
});
