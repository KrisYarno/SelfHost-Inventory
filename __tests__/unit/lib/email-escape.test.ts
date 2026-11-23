/**
 * @jest-environment node
 *
 * N0 (RC-4, N0-4 + C9) — every dynamic value in an email's HTML is escaped; the
 * plain-text bodies are unchanged.
 *
 * The HTML is captured from the provider call on jest.setup.js's GLOBAL
 * @sendgrid/mail mock (delivery switched on explicitly), so the pins see exactly
 * what would have gone out — and nothing can.
 */

import sgMail from "@sendgrid/mail";
import { EmailService, escapeHtml } from "@/lib/email";

const send = (sgMail as unknown as { send: jest.Mock }).send;
const OLD_ENV = process.env;

const EVIL_LINK = '<a href="https://evil.example">Approve</a>';
const EVIL_LINK_ESCAPED = "&lt;a href=&quot;https://evil.example&quot;&gt;Approve&lt;/a&gt;";
const SCRIPT = "<script>alert(1)</script>";
const SCRIPT_ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

beforeEach(() => {
  process.env = {
    ...OLD_ENV,
    SENDGRID_API_KEY: "SG.test",
    EMAIL_DELIVERY: "on",
    NEXTAUTH_URL: "https://app.example",
  };
  delete process.env.TEMPLATE_ID; // the inline-HTML path
  send.mockReset();
  send.mockResolvedValue([{ statusCode: 202, headers: {} }, {}]);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = OLD_ENV;
});

function sentMessage() {
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0][0] as { html: string; text: string };
}

describe("escapeHtml", () => {
  it("escapes & < > \" ' and renders null / undefined as an empty string", () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &#39; f");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(0)).toBe("0");
  });
});

describe("approval reminder", () => {
  it("a username or email carrying a link renders ESCAPED in the HTML (never a live link)", async () => {
    await new EmailService().sendApprovalReminderEmail(["admin@example.com"], {
      email: EVIL_LINK,
      username: EVIL_LINK,
    });
    const { html, text } = sentMessage();
    expect(html).not.toContain(EVIL_LINK);
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).toContain(`${EVIL_LINK_ESCAPED} (${EVIL_LINK_ESCAPED}) is waiting for account approval.`);
    // The review link itself is still a real link, escaped as an attribute.
    expect(html).toContain(
      'Review pending accounts at <a href="https://app.example/admin/users">https://app.example/admin/users</a>.'
    );
    // Plain text is unchanged (no HTML entities in a text body).
    expect(text).toBe(
      `${EVIL_LINK} (${EVIL_LINK}) is waiting for account approval.\n\n` +
        "Review pending accounts: https://app.example/admin/users"
    );
  });
});

describe("low-stock digest (inline HTML)", () => {
  it("a product name with <script> and an & render escaped; the text body is unchanged", async () => {
    await new EmailService().sendLowStockDigest("kris@example.com", {
      recipientName: `Kris & <b>Co</b>`,
      items: [
        { productName: SCRIPT, currentStock: 1, threshold: 5, daysUntilEmpty: 2 },
        { productName: "Salt & Pepper", currentStock: 0, threshold: 3, daysUntilEmpty: null },
      ],
    });
    const { html, text } = sentMessage();
    expect(html).not.toContain(SCRIPT);
    expect(html).toContain(`<strong>${SCRIPT_ESCAPED}</strong>`);
    expect(html).toContain("<strong>Salt &amp; Pepper</strong>");
    expect(html).not.toContain("Salt & Pepper");
    expect(html).toContain("Hi Kris &amp; &lt;b&gt;Co&lt;/b&gt;,");
    expect(html).toContain('<a href="https://app.example/inventory"');

    expect(text).toContain(`- ${SCRIPT}: 1 units (alert threshold: 5, days until empty: 2)`);
    expect(text).toContain("- Salt & Pepper: 0 units (alert threshold: 3, days until empty: N/A)");
    expect(text).toContain("Hi Kris & <b>Co</b>,");
  });
});

describe("minimums digest", () => {
  it("product and location names with <script> / & render escaped; the text body is unchanged", async () => {
    await new EmailService().sendMinimumsDigest("kris@example.com", {
      recipientName: "Kris",
      locationItems: [
        {
          productId: 1,
          productName: SCRIPT,
          locationId: 2,
          locationName: "Boise & Co",
          currentQuantity: 1,
          minQuantity: 4,
        },
      ],
      combinedItems: [
        { productId: 3, productName: "A & B", totalQuantity: 2, combinedMinimum: 9, daysUntilEmpty: null },
      ],
    });
    const { html, text } = sentMessage();
    expect(html).not.toContain(SCRIPT);
    expect(html).toContain(`>${SCRIPT_ESCAPED}</td>`);
    expect(html).toContain(">Boise &amp; Co</td>");
    expect(html).toContain(">A &amp; B</td>");
    expect(html).toContain("Manage notifications at https://app.example/account");

    expect(text).toContain(` - ${SCRIPT} @ Boise & Co: 1/4`);
    expect(text).toContain(" - A & B: 2/9 (days until empty: N/A)");
  });
});

describe("weekly report (C9: in scope)", () => {
  const data = {
    recipientName: `<img src=x onerror=alert(1)>`,
    dateRange: "Nov 16, 2026 - Nov 23, 2026",
    totalProducts: 12,
    totalStock: 340,
    lowStockCount: 1,
    lowStockItems: [{ name: SCRIPT, currentStock: 1, minimum: 5, deficit: 4 }],
    topMovers: [{ name: "Fish & Chips", unitsMoved: 7 }],
    stockByLocation: [{ name: `Main "Store"`, totalStock: 340 }],
  };

  it("every dynamic value renders escaped in the HTML", () => {
    const html = new EmailService().generateWeeklyReportHTML(data);
    expect(html).not.toContain(SCRIPT);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(`>${SCRIPT_ESCAPED}</td>`);
    expect(html).toContain("Hi &lt;img src=x onerror=alert(1)&gt;,");
    expect(html).toContain(">Fish &amp; Chips</td>");
    expect(html).toContain(">Main &quot;Store&quot;</td>");
    expect(html).toContain('<a href="https://app.example/dashboard"');
    expect(html).toContain('<a href="https://app.example/account"');
  });

  it("the text body is unchanged (raw values, no entities)", () => {
    const text = new EmailService().generateWeeklyReportText(data);
    expect(text).toContain(`  - ${SCRIPT}: 1 in stock (minimum: 5, deficit: 4)`);
    expect(text).toContain("  - Fish & Chips: 7 units moved");
    expect(text).toContain(`  - Main "Store": 340 units`);
    expect(text).toContain("Hi <img src=x onerror=alert(1)>,");
  });
});
