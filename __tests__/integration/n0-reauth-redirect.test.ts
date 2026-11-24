/**
 * @jest-environment node
 *
 * N0 FR2 F1 (FD1-1 = QA-1) — no redirect loop under a sustained DB failure.
 *
 * D0 re-reads the claims on every session read and RETHROWS when the read fails
 * (FR1 E1). In a server component getServerSession then returns null but cannot
 * clear the cookie, which still decodes as approved. Before F1:
 *   app layout: no session -> /auth/signin
 *   middleware: approved cookie on an auth route -> /workbench
 *   ...forever (ERR_TOO_MANY_REDIRECTS), spending the per-IP auth bucket.
 * F1: the layout sends `/auth/signin?reauth=1`, and the middleware lets that
 * marker render (the client session fetch there clears the stale cookie).
 *
 * The REAL middleware and the REAL app layout run; the cookie is a REAL next-auth
 * JWT, encoded with a test-only secret. Only getSession (the DB-failure case:
 * null) and the layout's client providers are stubbed.
 */

jest.mock("@/lib/auth", () => ({ __esModule: true, getSession: jest.fn() }));
jest.mock("next/navigation", () => ({
  __esModule: true,
  redirect: jest.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: url });
  }),
}));
jest.mock("@/components/layout/app-shell", () => ({ __esModule: true, AppShell: () => null }));
jest.mock("@/contexts/location-context", () => ({ __esModule: true, LocationProvider: () => null }));
jest.mock("@/components/error-boundary", () => ({ __esModule: true, ErrorBoundary: () => null }));

import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { middleware } from "@/middleware";
import AppLayout from "@/app/(app)/layout";

const TEST_SECRET = "n0-fr2-reauth-test-secret-not-a-real-one";
const ORIGINAL = { secret: process.env.NEXTAUTH_SECRET, url: process.env.NEXTAUTH_URL, vercel: process.env.VERCEL };

let ip = 0;
let cookie = "";

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = TEST_SECRET;
  process.env.NEXTAUTH_URL = "http://localhost"; // => the non-__Secure cookie name
  delete process.env.VERCEL;
  const jwt = await encode({
    secret: TEST_SECRET,
    token: {
      id: 42,
      email: "member@example.com",
      name: "member",
      isAdmin: false,
      isApproved: true,
      defaultLocationId: null,
    },
  });
  cookie = `next-auth.session-token=${jwt}`;
});

afterAll(() => {
  for (const [key, value] of [
    ["NEXTAUTH_SECRET", ORIGINAL.secret],
    ["NEXTAUTH_URL", ORIGINAL.url],
    ["VERCEL", ORIGINAL.vercel],
  ] as const) {
    const env = process.env as Record<string, string | undefined>;
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

function visit(pathAndQuery: string, withCookie = true) {
  return middleware(
    new NextRequest(`http://localhost${pathAndQuery}`, {
      headers: { "x-forwarded-for": `198.51.100.${++ip}`, ...(withCookie ? { cookie } : {}) },
    })
  );
}

/** What the app layout does for this request: a redirect target, or null (renders). */
async function layoutRedirect(): Promise<string | null> {
  try {
    await AppLayout({ children: null });
    return null;
  } catch (error) {
    const target = (error as { redirectTo?: string }).redirectTo;
    if (target === undefined) throw error;
    return target;
  }
}

/**
 * A browser following redirects from `start`: the middleware runs on every hop;
 * an app page (not /auth/*) that the middleware lets through runs the layout.
 * Returns every redirect taken, stopping when a page renders (or at 10 hops).
 */
async function follow(start: string): Promise<{ redirects: string[]; renderedAt: string | null }> {
  const redirects: string[] = [];
  let at = start;
  for (let hop = 0; hop < 10; hop++) {
    const res = await visit(at);
    const location = res.headers.get("location");
    if (location) {
      const next = new URL(location);
      at = `${next.pathname}${next.search}`;
      redirects.push(at);
      continue;
    }
    if (at.startsWith("/auth/")) return { redirects, renderedAt: at };
    const target = await layoutRedirect();
    if (target === null) return { redirects, renderedAt: at };
    redirects.push(target);
    at = target;
  }
  return { redirects, renderedAt: null };
}

describe("F1: a null server session with an approved cookie", () => {
  beforeEach(() => {
    (getSession as jest.Mock).mockResolvedValue(null); // the claims re-read is failing
  });

  it("the layout sends it to /auth/signin?reauth=1", async () => {
    expect(await layoutRedirect()).toBe("/auth/signin?reauth=1");
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("the middleware lets /auth/signin?reauth=1 render (no /workbench redirect) even with the cookie", async () => {
    const res = await visit("/auth/signin?reauth=1");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("end to end from /workbench: exactly ONE redirect, then the sign-in page renders", async () => {
    const { redirects, renderedAt } = await follow("/workbench");
    expect(redirects).toEqual(["/auth/signin?reauth=1"]);
    expect(renderedAt).toBe("/auth/signin?reauth=1");
  });
});

describe("F1 leaves the normal paths alone", () => {
  it("a normal signed-in visit to /auth/signin (no marker) still goes to /workbench", async () => {
    const res = await visit("/auth/signin");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/workbench");
  });

  it("only the exact marker counts: reauth=0 / reauth=true still go to /workbench", async () => {
    for (const q of ["?reauth=0", "?reauth=true", "?reauth="]) {
      const res = await visit(`/auth/signin${q}`);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/workbench");
    }
  });

  it("with no cookie, /auth/signin renders as before", async () => {
    const res = await visit("/auth/signin", false);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a healthy session renders the app (no redirect at all)", async () => {
    (getSession as jest.Mock).mockResolvedValue({
      user: { id: 42, email: "member@example.com", isAdmin: false, isApproved: true },
    });
    expect(await follow("/workbench")).toEqual({ redirects: [], renderedAt: "/workbench" });
  });

  it("an unapproved server session still goes to /auth/pending-approval", async () => {
    (getSession as jest.Mock).mockResolvedValue({
      user: { id: 42, email: "member@example.com", isAdmin: false, isApproved: false },
    });
    expect(await layoutRedirect()).toBe("/auth/pending-approval");
  });
});
