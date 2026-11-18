/** @jest-environment jsdom */
//
// Facelift F1-4 (plan 2026-11-18-facelift-f1 REV 2; FL-A-11; OC1-12..14,
// G1-7, G1-8) — route-level states for the authenticated pages.
//
//   - `app/(app)/error.tsx`: a client error state INSIDE the shell (the class
//     ErrorBoundary around the shell stays for shell errors). Try again calls
//     reset(); Reload calls window.location.reload(); the error is logged.
//   - `app/(app)/loading.tsx`: only the page gutter and a title-bar skeleton.
//   - `app/(app)/not-found.tsx`: a not-found state inside the shell, with a way
//     back to the workbench.
//   - `app/(app)/[...missing]/page.tsx`: calls notFound(), so an unmatched
//     authenticated URL renders that not-found page inside the shell.

import * as React from "react";
import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotFoundBoundary } from "next/dist/client/components/not-found-boundary";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import AppRouteError from "@/app/(app)/error";
import AppRouteLoading from "@/app/(app)/loading";
import AppRouteNotFound from "@/app/(app)/not-found";
import MissingPage from "@/app/(app)/[...missing]/page";

const ERROR_BODY =
  "Try again, or reload the app if this keeps happening. If you were saving something, check whether it went through before doing it again.";
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("F1-4 — app/(app)/error.tsx", () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("is a client component", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/(app)/error.tsx"), "utf8");
    expect(src.trimStart().startsWith('"use client";')).toBe(true);
  });

  it("renders the copy and classes the contract gives, byte for byte", () => {
    const { container } = render(<AppRouteError error={new Error("boom")} reset={() => {}} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("class")).toBe("px-4 sm:px-6 py-8 max-w-xl");

    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Something went wrong on this page.");
    expect(h1.getAttribute("class")).toBe("text-h2");

    const body = screen.getByText(ERROR_BODY);
    expect(body.tagName).toBe("P");
    expect(body.getAttribute("class")).toBe("mt-2 text-body-sm text-muted-foreground");

    const tryAgain = screen.getByRole("button", { name: "Try again" });
    const reload = screen.getByRole("button", { name: "Reload" });
    expect(tryAgain.parentElement).toBe(reload.parentElement);
    expect(tryAgain.parentElement!.getAttribute("class")).toBe("mt-4 flex gap-2");
    // Try again is the default variant, Reload the outline variant
    expect(classesOf(tryAgain)).toContain("bg-primary");
    expect(classesOf(reload)).toEqual(expect.arrayContaining(["border", "border-input", "bg-background"]));
    expect(classesOf(reload)).not.toContain("bg-primary");
    expect(Array.from(tryAgain.parentElement!.children)).toEqual([tryAgain, reload]);
  });

  it("Try again calls reset()", async () => {
    const reset = jest.fn();
    render(<AppRouteError error={new Error("boom")} reset={reset} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("Reload calls window.location.reload()", async () => {
    // jsdom's Location is unforgeable (its reload cannot be replaced or spied
    // on), and jsdom does not implement navigation: a real reload() reaches its
    // navigation path and reports "Not implemented: navigation" on the console.
    // So the click is proven to call the real location.reload() by that signal
    // (and Try again never raises it), and the handler is read off the source.
    const NAV = /Not implemented: navigation/;
    const navCalls = () =>
      errorSpy.mock.calls.filter((c) => c.some((a: unknown) => NAV.test(String((a as Error)?.message ?? a)))).length;
    render(<AppRouteError error={new Error("boom")} reset={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(navCalls()).toBe(0);
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(navCalls()).toBe(1);

    const src = fs.readFileSync(path.join(process.cwd(), "app/(app)/error.tsx"), "utf8");
    expect(src).toMatch(/<Button variant="outline" onClick=\{\(\) => window\.location\.reload\(\)\}>\s*Reload\s*<\/Button>/);
  });

  it("logs the error with console.error (in an effect)", () => {
    const error = new Error("boom");
    render(<AppRouteError error={error} reset={() => {}} />);
    expect(errorSpy).toHaveBeenCalledWith(error);
  });
});

describe("F1-4 — app/(app)/loading.tsx", () => {
  it("is only the page gutter and a title-bar skeleton", () => {
    const { container } = render(<AppRouteLoading />);
    const status = screen.getByRole("status", { name: "Loading" });
    expect(container.firstElementChild).toBe(status);
    expect(status.getAttribute("class")).toBe("px-4 sm:px-6 py-4");
    expect(status.children).toHaveLength(1);
    const skeleton = status.firstElementChild as HTMLElement;
    expect(classesOf(skeleton)).toEqual(expect.arrayContaining(["h-7", "w-40", "animate-pulse", "bg-foreground/10"]));
    expect(skeleton.children).toHaveLength(0);
  });
});

describe("F1-4 — app/(app)/not-found.tsx", () => {
  it("renders its copy, the link to the workbench, and the error page's layout classes", () => {
    const { container } = render(<AppRouteNotFound />);
    expect((container.firstElementChild as HTMLElement).getAttribute("class")).toBe("px-4 sm:px-6 py-8 max-w-xl");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("This page doesn't exist.");
    expect(h1.getAttribute("class")).toBe("text-h2");
    const link = screen.getByRole("link", { name: "Go to the workbench" });
    expect(link.getAttribute("href")).toBe("/workbench");
  });
});

describe("F1-4 — app/(app)/[...missing]/page.tsx", () => {
  it("/no-such-page renders the not-found copy: the catch-all calls notFound() and the (app) not-found boundary shows the page", () => {
    // The catch-all at the (app) root matches any unmatched path of one or more segments.
    const { re } = getRouteRegex("/[...missing]");
    expect(re.test("/no-such-page")).toBe(true);
    expect(re.test("/admin/no-such-page")).toBe(true);
    expect(re.test("/")).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "app/(app)/[...missing]/page.tsx"))).toBe(true);

    // Next's own not-found boundary (what the (app) segment wraps its pages in)
    // catches the real notFound() the page throws and renders not-found.tsx.
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <NotFoundBoundary notFound={<AppRouteNotFound />}>
          {/* the page renders nothing of its own (it only throws), so its
              type is () => void; React renders it as any component */}
          {React.createElement(MissingPage as unknown as React.FC)}
        </NotFoundBoundary>
      );
    } finally {
      errorSpy.mockRestore();
    }
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("This page doesn't exist.");
    expect(screen.getByRole("link", { name: "Go to the workbench" })).toBeInTheDocument();
  });

  it("calls notFound() and renders nothing of its own", () => {
    expect(() => MissingPage()).toThrow(expect.objectContaining({ digest: "NEXT_NOT_FOUND" }));
  });
});
