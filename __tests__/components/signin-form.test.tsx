/**
 * @jest-environment jsdom
 *
 * N0 FR3 — the sign-in form.
 *   - G2 (FD2-2): next-auth puts a thrown error's MESSAGE in `result.error`, so the
 *     form maps it to ONE of three fixed sentences and never renders the raw value.
 *   - H1 (FD3-1, withdraws FR3 G5's automatic return): arriving with `reauth=1`
 *     (the app layout's marker) while the client session is authenticated, the
 *     form shows one line and a plain link to the FIXED /workbench — never
 *     `callbackUrl` — and nothing navigates by itself.
 *   - H3: a raw `?error=` value is never rendered.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const replace = jest.fn();
const push = jest.fn();
let search = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, prefetch: jest.fn() }),
  useSearchParams: () => search,
}));

// N0 FR5 I1: next/link is replaced by a MARKER anchor, so a pin can tell a plain
// <a> (a document navigation) from a next/link (a client-side one).
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a jest.mock factory cannot close over the JSX runtime
    require("react").createElement("a", { "data-next-link": "true", href, ...rest }, children),
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

// N0 FR4 H1 SUPERSEDES the FR3 G5 pins ("router.replace('/workbench')" on the
// marker): the AUTOMATIC return is withdrawn (it could cycle with the layout under
// a flapping database). Instead the form OFFERS the way back — one line and a plain
// link to the fixed /workbench — and nothing navigates by itself.
const LINE = "You're still signed in.";

function returnLink(): HTMLAnchorElement | null {
  return screen.queryByRole("link", { name: "Return to the workbench" }) as HTMLAnchorElement | null;
}

describe("H1: the reauth marker OFFERS a link back; nothing navigates by itself", () => {
  it("with reauth=1 and an authenticated session => the line and a link to /workbench, no navigation", async () => {
    search = new URLSearchParams("reauth=1");
    useSessionMock.mockReturnValue({ data: { user: { isApproved: true } }, status: "authenticated" });
    render(<SignInForm />);

    const link = returnLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/workbench");
    expect(link!.closest("p")!.textContent).toBe(`${LINE} Return to the workbench`);
    // ONE line, above the form.
    expect(screen.getAllByText(/still signed in/)).toHaveLength(1);
    expect(
      link!.closest("p")!.compareDocumentPosition(document.querySelector("form")!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("never navigates by itself, across an unmount and a remount", async () => {
    search = new URLSearchParams("reauth=1");
    useSessionMock.mockReturnValue({ data: { user: { isApproved: true } }, status: "authenticated" });
    const first = render(<SignInForm />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.unmount();
    render(<SignInForm />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returnLink()).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("callbackUrl=https://evil.example => the link is still /workbench", () => {
    search = new URLSearchParams("reauth=1&callbackUrl=https%3A%2F%2Fevil.example%2Fphish");
    useSessionMock.mockReturnValue({ data: { user: { isApproved: true } }, status: "authenticated" });
    render(<SignInForm />);
    expect(returnLink()!.getAttribute("href")).toBe("/workbench");
    for (const anchor of Array.from(document.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toContain("evil.example");
    }
    expect(replace).not.toHaveBeenCalled();
  });

  it("without the marker => no line, even when authenticated", () => {
    search = new URLSearchParams("callbackUrl=%2Fworkbench");
    useSessionMock.mockReturnValue({ data: { user: { isApproved: true } }, status: "authenticated" });
    render(<SignInForm />);
    expect(screen.queryByText(/still signed in/)).not.toBeInTheDocument();
    expect(returnLink()).toBeNull();
  });

  it.each([["loading"], ["unauthenticated"]])("with the marker but a %s session => no line", (status) => {
    search = new URLSearchParams("reauth=1");
    useSessionMock.mockReturnValue({ data: null, status });
    render(<SignInForm />);
    expect(screen.queryByText(/still signed in/)).not.toBeInTheDocument();
    expect(returnLink()).toBeNull();
  });

  it("only the exact marker counts (reauth=true => no line)", () => {
    search = new URLSearchParams("reauth=true");
    useSessionMock.mockReturnValue({ data: { user: { isApproved: true } }, status: "authenticated" });
    render(<SignInForm />);
    expect(returnLink()).toBeNull();
  });
});

// N0 FR4 H3: a raw `?error=` value on the sign-in page is never rendered.
describe("H3: ?error=<raw text> renders no raw text", () => {
  it.each([
    ["Can't reach database server at `db.internal.example:3306` as user `inventory_app_user`"],
    ["<img src=x onerror=alert(1)>"],
    ["ServiceUnavailable"],
  ])("?error=%j", (raw) => {
    search = new URLSearchParams({ error: raw });
    render(<SignInForm />);
    expect(document.body.textContent).not.toContain(raw);
    expect(document.body.textContent).not.toContain("db.internal");
    expect(document.querySelector("img")).toBeNull();
  });

  it("?error=CredentialsSignin still shows its fixed sentence", () => {
    search = new URLSearchParams("error=CredentialsSignin");
    render(<SignInForm />);
    expect(screen.getByText("Invalid email or password")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// N0 FR5 (FD4): I1 a plain anchor, I2 approved only, I3 an always-present status region.
// ---------------------------------------------------------------------------
function statusRegion(): HTMLElement {
  return screen.getByRole("status");
}

describe("FR5 I1: the way back is a PLAIN anchor (a document navigation), never next/link", () => {
  it("the rendered link is a plain <a href=\"/workbench\">, not the next/link marker", () => {
    search = new URLSearchParams("reauth=1");
    useSessionMock.mockReturnValue({ data: { user: { isApproved: true } }, status: "authenticated" });
    render(<SignInForm />);
    const link = returnLink()!;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/workbench");
    expect(link.hasAttribute("data-next-link")).toBe(false);
    // The marker mock IS active: the page's other next/link (Sign up) carries it.
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("data-next-link")).toBe("true");
  });
});

describe("FR5 I2: the line requires an APPROVED session", () => {
  it.each([
    ["isApproved: false", { user: { isApproved: false } }],
    ["no isApproved", { user: {} }],
    ["isApproved as a string", { user: { isApproved: "true" } }],
    ["no user", {}],
  ])("authenticated with %s => no line", (_label, data) => {
    search = new URLSearchParams("reauth=1");
    useSessionMock.mockReturnValue({ data, status: "authenticated" });
    render(<SignInForm />);
    expect(screen.queryByText(/still signed in/)).not.toBeInTheDocument();
    expect(returnLink()).toBeNull();
  });
});

describe("FR5 I3: the status region is always rendered; it holds the line only when shown", () => {
  it.each([
    ["marker + approved", "reauth=1", { data: { user: { isApproved: true } }, status: "authenticated" }, true],
    ["marker + unapproved", "reauth=1", { data: { user: { isApproved: false } }, status: "authenticated" }, false],
    ["marker + loading", "reauth=1", { data: null, status: "loading" }, false],
    ["marker + unauthenticated", "reauth=1", { data: null, status: "unauthenticated" }, false],
    ["no marker + approved", "", { data: { user: { isApproved: true } }, status: "authenticated" }, false],
  ])("%s", (_label, query, session, shown) => {
    search = new URLSearchParams(query);
    useSessionMock.mockReturnValue(session);
    render(<SignInForm />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(statusRegion().textContent).toBe(shown ? `${LINE} Return to the workbench` : "");
    if (shown) expect(statusRegion().contains(returnLink())).toBe(true);
  });
});
