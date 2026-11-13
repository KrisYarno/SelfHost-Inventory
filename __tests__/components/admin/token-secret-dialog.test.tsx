/** @jest-environment jsdom */
/**
 * `components/admin/ai/token-secret-dialog.tsx` — § P2-B3-1R, M-b2 fix 10
 * (MS-3-26).
 *
 * A new API token is shown ONCE. The dialog already refused an outside click;
 * Escape still closed it, and the parent then nulled the plaintext — one stray
 * Escape before Copy lost a token that can never be shown again. Now Escape is
 * refused too, and only `Done` closes.
 *
 * The token here is an obvious fake.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

import { TokenSecretDialog, SECRET_ONCE_COPY } from "@/components/admin/ai/token-secret-dialog";

const FAKE_TOKEN = "invmcp_FAKE_TEST_TOKEN_0000";

/** The host as `token-section.tsx` wires it: closing nulls the plaintext. */
function Host({ onClose }: { onClose: jest.Mock }) {
  const [token, setToken] = React.useState<string | null>(FAKE_TOKEN);
  return (
    <TokenSecretDialog
      token={token}
      tokenName="Test client"
      onClose={() => {
        onClose();
        setToken(null);
      }}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("the new API token (MS-3-26)", () => {
  it("Escape keeps the dialog AND the token", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<Host onClose={onClose} />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(FAKE_TOKEN)).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(FAKE_TOKEN)).toBeInTheDocument();
    expect(screen.getByText(SECRET_ONCE_COPY)).toBeInTheDocument();
  });

  it("Escape is refused even with focus on Copy (the moment before copying)", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<Host onClose={onClose} />);

    screen.getByRole("button", { name: "Copy token" }).focus();
    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(FAKE_TOKEN)).toBeInTheDocument();
  });

  it("only Done closes it, and closing clears the plaintext", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<Host onClose={onClose} />);

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText(FAKE_TOKEN)).toBeNull();
  });
});
