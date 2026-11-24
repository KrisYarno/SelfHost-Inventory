/**
 * @jest-environment jsdom
 *
 * N0 FR3 — the sign-in form.
 *   - G2 (FD2-2): next-auth puts a thrown error's MESSAGE in `result.error`, so the
 *     form maps it to ONE of three fixed sentences and never renders the raw value.
 *   - G5 (FD2-5): arriving with `reauth=1` (the app layout's marker), once the
 *     client session is authenticated the form returns to the FIXED /workbench —
 *     never `callbackUrl`, which is attacker-controlled.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const replace = jest.fn();
let search = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => search,
}));

// jest.setup.js mocks next-auth/react with useSession only; give the form a signIn.
jest.mock("next-auth/react", () => ({
  signIn: jest.fn(),
  useSession: jest.fn(() => ({ data: null, status: "loading" })),
}));

import { signIn, useSession } from "next-auth/react";
import { SignInForm } from "@/app/auth/signin/signin-form";

const signInMock = signIn as unknown as jest.Mock;
const useSessionMock = useSession as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  search = new URLSearchParams("");
  useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
});

async function submitWith(error: string) {
  signInMock.mockResolvedValue({ error, ok: false, status: 401, url: null });
  render(<SignInForm />);
  fireEvent.change(screen.getByPlaceholderText("Email address"), { target: { value: "a@example.com" } });
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(signInMock).toHaveBeenCalled());
}

describe("G2: a sign-in error is one of three fixed sentences", () => {
  it("CredentialsSignin => Invalid email or password (unchanged)", async () => {
    await submitWith("CredentialsSignin");
    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
  });

  it("ServiceUnavailable => the unavailable sentence", async () => {
    await submitWith("ServiceUnavailable");
    expect(
      await screen.findByText("Sign-in is unavailable right now. Please try again in a few minutes.")
    ).toBeInTheDocument();
  });

  it("ANY other error => the generic sentence, and the raw value is never rendered", async () => {
    const raw = "Can't reach database server at `db.internal.example:3306` as user `inventory_app_user`";
    await submitWith(raw);
    expect(await screen.findByText("Sign-in failed. Please try again.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("db.internal.example");
    expect(document.body.textContent).not.toContain(raw);
  });
});

describe("G5: the reauth marker returns an authenticated user to the FIXED /workbench", () => {
  it("with reauth=1 and an authenticated session => router.replace('/workbench')", async () => {
    search = new URLSearchParams("reauth=1");
    useSessionMock.mockReturnValue({ data: { user: {} }, status: "authenticated" });
    render(<SignInForm />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workbench"));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("never targets callbackUrl, even when one is in the URL", async () => {
    search = new URLSearchParams("reauth=1&callbackUrl=https%3A%2F%2Fevil.example%2Fphish");
    useSessionMock.mockReturnValue({ data: { user: {} }, status: "authenticated" });
    render(<SignInForm />);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls).toEqual([["/workbench"]]);
  });

  it("without the marker => no replace, even when authenticated", async () => {
    search = new URLSearchParams("callbackUrl=%2Fworkbench");
    useSessionMock.mockReturnValue({ data: { user: {} }, status: "authenticated" });
    render(<SignInForm />);
    await screen.findByRole("button", { name: "Sign in" });
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([["loading"], ["unauthenticated"]])("with the marker but a %s session => no replace", async (status) => {
    search = new URLSearchParams("reauth=1");
    useSessionMock.mockReturnValue({ data: null, status });
    render(<SignInForm />);
    await screen.findByRole("button", { name: "Sign in" });
    expect(replace).not.toHaveBeenCalled();
  });

  it("only the exact marker counts (reauth=true => no replace)", async () => {
    search = new URLSearchParams("reauth=true");
    useSessionMock.mockReturnValue({ data: { user: {} }, status: "authenticated" });
    render(<SignInForm />);
    await screen.findByRole("button", { name: "Sign in" });
    expect(replace).not.toHaveBeenCalled();
  });
});
