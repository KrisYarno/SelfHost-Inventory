/**
 * @jest-environment node
 *
 * Lane 5 S4 — dev/demo surfaces gated out of prod.
 *   1. The three demo pages + the empty grouped-card dir are deleted from the tree.
 *   2. app/api/test/csrf is admin-gated (mirrors app/api/test/email's isAdmin 401):
 *      a non-admin (merely approved) session is rejected 401.
 */

import fs from "fs";
import path from "path";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn() }));
jest.mock("@/lib/auth", () => ({ authOptions: {} }));

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { validateCSRFToken } from "@/lib/csrf";
import { POST as CSRF_POST } from "@/app/api/test/csrf/route";

const REPO_ROOT = process.cwd();

describe("S4 — demo pages removed from the tree", () => {
  const removed = [
    "app/ui-components/page.tsx",
    "app/test-design-tokens/page.tsx",
    "app/theme-test/page.tsx",
    "app/ui-components",
    "app/test-design-tokens",
    "app/theme-test",
    "app/test-grouped-card",
  ];

  it.each(removed)("%s does not exist", (rel) => {
    expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(false);
  });
});

describe("S4 — app/api/test/csrf is admin-gated", () => {
  function req() {
    return new NextRequest("http://x/api/test/csrf", {
      method: "POST",
      body: JSON.stringify({ ping: 1 }),
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  });

  it("rejects a non-admin (approved-only) session with 401", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { isApproved: true, isAdmin: false },
    });
    const res = await CSRF_POST(req());
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated request with 401", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const res = await CSRF_POST(req());
    expect(res.status).toBe(401);
  });

  it("admits an admin session", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { isApproved: true, isAdmin: true },
    });
    const res = await CSRF_POST(req());
    expect(res.status).toBe(200);
  });
});
