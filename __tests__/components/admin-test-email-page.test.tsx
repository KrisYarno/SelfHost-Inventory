/**
 * @jest-environment jsdom
 *
 * N0 — the admin test-email page tells the truth.
 *   - C3: a 409 from /api/test/email shows the server's reason text RED, never
 *     the green tick.
 *   - X1-9 / FV-9: the current delivery mode, read from GET /api/healthz, is shown
 *     beside the buttons.
 *   - D1: "Run Stock Check Now" states both runs' counts.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token" }),
  withCSRFHeaders: (headers: Record<string, string>) => headers,
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

import TestEmailPage from "@/app/(app)/admin/test-email/page";

type Route = { ok: boolean; status: number; body: unknown };

function installFetch(routes: Record<string, Route | Error>) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const key = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
    const route = key ? routes[key] : { ok: false, status: 404, body: {} };
    if (route instanceof Error) throw route;
    return { ok: route.ok, status: route.status, json: async () => route.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const HEALTHZ_OFF: Route = {
  ok: true,
  status: 200,
  body: {
    status: "ok",
    emailDelivery: {
      mode: "off",
      allowlistCount: 0,
      invalidEnv: false,
      invalidReasons: [],
      providerConfigured: true,
    },
  },
};

afterEach(() => {
  jest.clearAllMocks();
});

it("shows the current delivery mode from /api/healthz beside the buttons", async () => {
  installFetch({ "/api/healthz": HEALTHZ_OFF });
  render(<TestEmailPage />);
  await waitFor(() => expect(screen.getAllByText("Email delivery: off")).toHaveLength(2));
  expect(global.fetch).toHaveBeenCalledWith("/api/healthz");
});

it("flags a configuration the server did not understand", async () => {
  installFetch({
    "/api/healthz": {
      ok: true,
      status: 200,
      body: { emailDelivery: { mode: "off", invalidEnv: true, invalidReasons: ["EMAIL_DELIVERY"] } },
    },
  });
  render(<TestEmailPage />);
  await waitFor(() =>
    expect(screen.getAllByText("Email delivery: off (configuration not understood)")).toHaveLength(2)
  );
});

it("says so when the mode cannot be read (never guesses one)", async () => {
  installFetch({ "/api/healthz": new Error("network down") });
  render(<TestEmailPage />);
  await waitFor(() =>
    expect(screen.getAllByText("Email delivery mode could not be read.")).toHaveLength(2)
  );
});

it("a 409 (delivery off) shows the server's text RED, not the green tick", async () => {
  installFetch({
    "/api/healthz": HEALTHZ_OFF,
    "/api/test/email": {
      ok: false,
      status: 409,
      body: { success: false, error: "Email delivery is off on this server (EMAIL_DELIVERY)." },
    },
  });
  render(<TestEmailPage />);
  fireEvent.click(screen.getByRole("button", { name: "Send Test Email" }));

  const text = await screen.findByText("Email delivery is off on this server (EMAIL_DELIVERY).");
  const alert = text.closest('[role="alert"]') as HTMLElement;
  expect(alert).not.toBeNull();
  expect(alert.className).toContain("border-destructive");
  expect(alert.className).not.toContain("border-success");
  expect(alert.querySelector(".text-success")).toBeNull();
  expect(alert.querySelector(".text-destructive")).not.toBeNull();
  expect(screen.queryByText("Test email sent successfully")).not.toBeInTheDocument();
});

it("'Run Stock Check Now' states both runs' counts", async () => {
  installFetch({
    "/api/healthz": HEALTHZ_OFF,
    "/api/admin/stock-check": {
      ok: true,
      status: 200,
      body: {
        success: true,
        lowStockCount: 3,
        locationBreaches: 2,
        combinedBreaches: 0,
        lowStock: {
          emailsSent: 0,
          emailsNotSent: 3,
          emailsFailed: 0,
          notSentReasons: { unconfigured: 0, off: 3, not_allowlisted: 0 },
        },
        minimums: {
          emailsSent: 0,
          emailsNotSent: 2,
          emailsFailed: 0,
          notSentReasons: { unconfigured: 0, off: 2, not_allowlisted: 0 },
        },
      },
    },
  });
  render(<TestEmailPage />);
  fireEvent.click(screen.getByRole("button", { name: "Run Stock Check Now" }));

  expect(
    await screen.findByText(
      "Stock check completed. Found 3 low stock item(s). " +
        "Low-stock emails: 0 sent, 3 not sent (off). " +
        "Minimum emails: 0 sent, 2 not sent (off)."
    )
  ).toBeInTheDocument();
});

it("mixed reasons and provider failures are each stated", async () => {
  installFetch({
    "/api/healthz": HEALTHZ_OFF,
    "/api/admin/stock-check": {
      ok: true,
      status: 200,
      body: {
        success: true,
        lowStockCount: 1,
        lowStock: {
          emailsSent: 1,
          emailsNotSent: 2,
          emailsFailed: 1,
          notSentReasons: { unconfigured: 0, off: 0, not_allowlisted: 2 },
        },
        minimums: {
          emailsSent: 0,
          emailsNotSent: 3,
          emailsFailed: 0,
          notSentReasons: { unconfigured: 1, off: 0, not_allowlisted: 2 },
        },
      },
    },
  });
  render(<TestEmailPage />);
  fireEvent.click(screen.getByRole("button", { name: "Run Stock Check Now" }));

  expect(
    await screen.findByText(
      "Stock check completed. Found 1 low stock item(s). " +
        "Low-stock emails: 1 sent, 2 not sent (not_allowlisted), 1 failed. " +
        "Minimum emails: 0 sent, 3 not sent (1 unconfigured, 2 not_allowlisted)."
    )
  ).toBeInTheDocument();
});
