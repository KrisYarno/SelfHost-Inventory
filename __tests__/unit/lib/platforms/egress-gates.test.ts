/**
 * @jest-environment node
 */

/**
 * Lane 6 T4 — THE GATE MATRIX.
 *
 * This is the file that has to be right. The owner runs a live WooCommerce store,
 * both integrations hold write-capable keys, and `updateOrderStatus` is kept in
 * the codebase on purpose. The software carries the entire guarantee, and this
 * suite is the proof of it.
 *
 * Every blocked/dry-run case asserts `fetch` was called ZERO times. "The adapter
 * mock wasn't called" is not evidence — bytes are.
 */

import { pushStockStatus, pushOrderStatus } from "@/lib/platforms/egress";
import prisma from "@/lib/prisma";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    integration: { findUnique: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    platformWriteAttempt: { create: jest.fn(), update: jest.fn() },
  },
}));

jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordIngestion: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/lib/encryption", () => ({
  __esModule: true,
  isEncrypted: jest.fn(() => false),
  decryptValue: jest.fn((v: string) => v),
}));

const db = prisma as unknown as {
  integration: { findUnique: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
  platformWriteAttempt: { create: jest.Mock; update: jest.Mock };
};

const STORE = "https://store.example.com";

function integrationRow(over: Record<string, unknown> = {}) {
  return {
    id: "int-1",
    companyId: "co-1",
    name: "Awake Store",
    platform: "WOOCOMMERCE",
    storeUrl: STORE,
    isActive: true,
    stockSyncEnabled: true,
    fulfillmentPushEnabled: true,
    updatedAt: new Date("2026-07-14T00:00:00Z"),
    encryptedWriteKey: "ck_write",
    encryptedWriteSecret: "cs_write",
    encryptedReadKey: "ck_read",
    encryptedReadSecret: "cs_read",
    ...over,
  };
}

/** A 200 with a WC-shaped batch body. */
function ok(body: unknown = { update: [] }) {
  return {
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: jest.Mock;
const ORIGINAL_ENV = { ...process.env };

/** Both gates open. Individual tests knock one out at a time. */
function allowAll() {
  process.env.PLATFORM_WRITES = "on";
  process.env.PLATFORM_WRITE_CAPABILITIES = "stock_status,order_status";
  db.integration.findUnique.mockResolvedValue(integrationRow());
  db.systemSetting.findUnique.mockResolvedValue(null); // kill switch not engaged
  db.platformWriteAttempt.create.mockResolvedValue({ id: 1 });
  db.platformWriteAttempt.update.mockResolvedValue({});
}

const STOCK = [{ externalProductId: "10", inStock: true }];

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PLATFORM_WRITES;
  delete process.env.PLATFORM_WRITE_CAPABILITIES;

  fetchMock = jest.fn().mockResolvedValue(ok());
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

/** Every result inside a fan-out, flattened. */
function flatten(result: any): any[] {
  return result.status === "partial"
    ? result.results.flatMap(flatten)
    : [result];
}

/** Drive a capability through the module's real public entry point. */
async function drive(capability: "stock_status" | "order_status") {
  return capability === "stock_status"
    ? pushStockStatus("int-1", STOCK)
    : pushOrderStatus("int-1", "555", "completed");
}

const BOTH = ["stock_status", "order_status"] as const;

// ===========================================================================
// The matrix — every gate, both capabilities, ZERO bytes
// ===========================================================================

describe.each(BOTH)("gate matrix [%s]", (capability) => {
  it("BLOCKS with master_off when PLATFORM_WRITES is unset (the production default)", async () => {
    allowAll();
    delete process.env.PLATFORM_WRITES;

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.status === "blocked")).toBe(true);
    expect(results.every((r) => r.reason === "master_off")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with invalid_env when PLATFORM_WRITES is a typo", async () => {
    allowAll();
    process.env.PLATFORM_WRITES = "onn";

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "invalid_env")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with capability_not_allowed when the token is absent from the allowlist", async () => {
    allowAll();
    // Allowlist the OTHER capability only.
    process.env.PLATFORM_WRITE_CAPABILITIES =
      capability === "stock_status" ? "order_status" : "stock_status";

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "capability_not_allowed")).toBe(
      true
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with kill_switch when the emergency stop is engaged", async () => {
    allowAll();
    db.systemSetting.findUnique.mockResolvedValue({ value: "true" });

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "kill_switch")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with integration_inactive when isActive is false", async () => {
    allowAll();
    db.integration.findUnique.mockResolvedValue(
      integrationRow({ isActive: false })
    );

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "integration_inactive")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with integration_inactive when the integration does not exist", async () => {
    allowAll();
    db.integration.findUnique.mockResolvedValue(null);

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.status === "blocked")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with wrong_platform for a non-WooCommerce integration", async () => {
    allowAll();
    db.integration.findUnique.mockResolvedValue(
      integrationRow({ platform: "SHOPIFY" })
    );

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "wrong_platform")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with integration_flag_off when the integration's own flag is false", async () => {
    allowAll();
    db.integration.findUnique.mockResolvedValue(
      integrationRow(
        capability === "stock_status"
          ? { stockSyncEnabled: false }
          : { fulfillmentPushEnabled: false }
      )
    );

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "integration_flag_off")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with no_write_credential when no write key is provisioned (R-E8)", async () => {
    allowAll();
    db.integration.findUnique.mockResolvedValue(
      integrationRow({ encryptedWriteKey: null, encryptedWriteSecret: null })
    );

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "no_write_credential")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("BLOCKS with insecure_store_url for an http:// store — NEVER upgrades it", async () => {
    allowAll();
    db.integration.findUnique.mockResolvedValue(
      integrationRow({ storeUrl: "http://store.example.com" })
    );

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.reason === "insecure_store_url")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("DRY RUNS with zero network I/O when the posture is dry-run", async () => {
    allowAll();
    process.env.PLATFORM_WRITES = "dry-run";

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.status === "dry_run")).toBe(true);
    // The exact request that WOULD have gone out.
    expect(results[0].wouldSend.url).toContain(STORE);
    expect(results[0].wouldSend.method).toBe(
      capability === "stock_status" ? "POST" : "PUT"
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("SENDS only when every gate is open", async () => {
    allowAll();

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.status === "sent")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("commits the pre-send authorization row BEFORE any byte leaves", async () => {
    allowAll();
    const order: string[] = [];
    db.platformWriteAttempt.create.mockImplementation(async () => {
      order.push("audit");
      return { id: 1 };
    });
    fetchMock.mockImplementation(async () => {
      order.push("fetch");
      return ok();
    });

    await drive(capability);

    expect(order[0]).toBe("audit");
    expect(order).toContain("fetch");
  });

  it("DOES NOT SEND when the authorization row cannot be committed (codex #13)", async () => {
    allowAll();
    db.platformWriteAttempt.create.mockRejectedValue(new Error("DB down"));

    const results = flatten(await drive(capability));

    // Fail closed: no audit row, no bytes.
    expect(results.every((r) => r.status === "failed")).toBe(true);
    expect(results.every((r) => r.reason === "audit_unavailable")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("records an audit row for a BLOCKED attempt too (a silent flip stays visible)", async () => {
    allowAll();
    delete process.env.PLATFORM_WRITES;

    await drive(capability);

    expect(db.platformWriteAttempt.create).toHaveBeenCalled();
    const data = db.platformWriteAttempt.create.mock.calls[0][0].data;
    expect(data.decision).toBe("block");
    expect(data.blockReason).toBe("master_off");
    expect(data.state).toBe("blocked");
  });

  it("refuses to follow a redirect (any 3xx is a hard failure)", async () => {
    allowAll();
    fetchMock.mockResolvedValue({
      status: 302,
      headers: new Headers({ location: "https://evil.example.com/steal" }),
      text: async () => "",
    } as unknown as Response);

    const results = flatten(await drive(capability));

    expect(results.every((r) => r.status === "failed")).toBe(true);
    expect(results.every((r) => r.reason === "redirect")).toBe(true);
    // One attempt, and we did NOT chase the Location header.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("pins https + the exact store origin on the wire", async () => {
    allowAll();

    await drive(capability);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.protocol).toBe("https:");
    expect(url.origin).toBe(STORE);
  });
});

// ===========================================================================
// Path-injection defense (REV-2 #3)
// ===========================================================================

describe("path-template assertion — the id cannot address another endpoint", () => {
  it.each([
    ["1/../../products/5"],
    ["../../products/batch"],
    ["555?force=true"],
    ["555/refunds"],
    ["1e3"],
    ["01x"],
    [""],
    ["null"],
    ["9 "],
  ])(
    "BLOCKS an order-status write with a non-canonical id %p",
    async (badId) => {
      allowAll();

      const result = (await pushOrderStatus(
        "int-1",
        badId as string,
        "completed"
      )) as { status: string; reason?: string };

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("invalid_target");
      expect(fetchMock).toHaveBeenCalledTimes(0);
    }
  );

  it("BLOCKS a stock write whose product id is not canonical decimal", async () => {
    allowAll();

    const results = flatten(
      await pushStockStatus("int-1", [
        { externalProductId: "10/../../orders/5", inStock: false },
      ])
    );

    expect(results.every((r) => r.reason === "invalid_target")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("ACCEPTS a canonical decimal id and lands on the exact template", async () => {
    allowAll();

    await pushOrderStatus("int-1", "555", "completed");

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/wp-json/wc/v3/orders/555");
  });

  it("refuses an order status outside the two permitted literals", async () => {
    allowAll();

    const result = (await pushOrderStatus(
      "int-1",
      "555",
      "cancelled" as unknown as "completed"
    )) as { status: string; reason?: string };

    // A caller cannot cancel an order through this function. Ever.
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("invalid_target");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ===========================================================================
// Retry policy (REV-2 #6)
// ===========================================================================

describe("retry — ONLY on a received 429, and never for order_status", () => {
  function rateLimited() {
    return {
      status: 429,
      headers: new Headers({ "Retry-After": "0" }),
      text: async () => "",
    } as unknown as Response;
  }

  it("stock_status retries ONCE after a 429", async () => {
    allowAll();
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());

    const results = flatten(await pushStockStatus("int-1", STOCK));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results[0].status).toBe("sent");
  }, 15_000);

  it("the retry MINTS A FRESH authorization row", async () => {
    allowAll();
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());

    await pushStockStatus("int-1", STOCK);

    const attempts = db.platformWriteAttempt.create.mock.calls.map(
      (c) => c[0].data.attemptNo
    );
    expect(attempts).toEqual([1, 2]);
  }, 15_000);

  it("the retry RE-EVALUATES the gates — a flag flipped off mid-flight stops it", async () => {
    allowAll();
    fetchMock.mockResolvedValueOnce(rateLimited());

    // Attempt 1 sees the flag on; the operator turns stock sync OFF; the retry
    // must NOT send. This is codex #10: a cached gate would push anyway.
    db.integration.findUnique
      .mockResolvedValueOnce(integrationRow()) // attempt 1 gate
      .mockResolvedValueOnce(integrationRow()) // attempt 1 fence
      .mockResolvedValue(integrationRow({ stockSyncEnabled: false })); // retry

    const results = flatten(await pushStockStatus("int-1", STOCK));

    // Exactly ONE wire call — the 429. The retry was blocked at the gate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("blocked");
    expect(results[0].reason).toBe("integration_flag_off");
  }, 15_000);

  it("order_status NEVER retries, even on a 429", async () => {
    allowAll();
    fetchMock.mockResolvedValue(rateLimited());

    const result = (await pushOrderStatus("int-1", "555", "completed")) as {
      status: string;
    };

    // A repeated order-status write is a business-visible event. One shot, ever.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
  });

  it("does NOT retry a timeout — the store may have applied it", async () => {
    allowAll();
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    const results = flatten(await pushStockStatus("int-1", STOCK));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].reason).toBe("outcome_unknown");
  });

  it("records outcome_unknown (not 'failed') when the response is lost", async () => {
    allowAll();
    const reset = new Error("socket hang up ECONNRESET");
    fetchMock.mockRejectedValue(reset);

    await pushStockStatus("int-1", STOCK);

    const finalize = db.platformWriteAttempt.update.mock.calls.at(-1)![0];
    expect(finalize.data.state).toBe("outcome_unknown");
  });

  it("does NOT retry a 500", async () => {
    allowAll();
    fetchMock.mockResolvedValue({
      status: 500,
      headers: new Headers(),
      text: async () => "boom",
    } as unknown as Response);

    const results = flatten(await pushStockStatus("int-1", STOCK));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].reason).toBe("http_error");
  });
});

// ===========================================================================
// The TOCTOU fence (REV-2 #4)
// ===========================================================================

describe("generation fence — never send under a stale authorization", () => {
  it("ABORTS when the config changes between authorization and send", async () => {
    allowAll();

    // Gate + audit see the flag ON. The fence (re-read immediately before the
    // bytes leave) sees it OFF.
    db.integration.findUnique
      .mockResolvedValueOnce(integrationRow()) // gate
      .mockResolvedValue(integrationRow({ stockSyncEnabled: false })); // fence

    const results = flatten(await pushStockStatus("int-1", STOCK));

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(results[0].status).toBe("blocked");
    expect(results[0].reason).toBe("config_changed");
  });

  it("ABORTS when the write credential is rotated between authorization and send", async () => {
    allowAll();

    db.integration.findUnique
      .mockResolvedValueOnce(integrationRow()) // gate
      .mockResolvedValue(integrationRow({ encryptedWriteKey: "ck_rotated" })); // fence

    const results = flatten(await pushStockStatus("int-1", STOCK));

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(results[0].reason).toBe("config_changed");
  });

  it("ABORTS when the kill switch is pulled between authorization and send", async () => {
    allowAll();

    db.systemSetting.findUnique
      .mockResolvedValueOnce(null) // gate: not engaged
      .mockResolvedValue({ value: "true" }); // fence: PULLED

    const results = flatten(await pushStockStatus("int-1", STOCK));

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(results[0].status).toBe("blocked");
  });

  it("SENDS when nothing changed", async () => {
    allowAll();

    const results = flatten(await pushStockStatus("int-1", STOCK));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("sent");
  });
});

// ===========================================================================
// Fan-out (REV-2 #5)
// ===========================================================================

describe("fan-out — partial success is explicit, never collapsed into 'sent'", () => {
  it("gives EACH wire request its own gate, its own audit row, and its own outcome", async () => {
    allowAll();

    // 60 simple products -> two batches of 50 + 10.
    const updates = Array.from({ length: 60 }, (_, i) => ({
      externalProductId: String(i + 1),
      inStock: true,
    }));

    const result = (await pushStockStatus("int-1", updates)) as {
      status: string;
      results: unknown[];
    };

    expect(result.status).toBe("partial");
    expect(result.results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.platformWriteAttempt.create).toHaveBeenCalledTimes(2);
  });

  it("reports a MIXED outcome honestly", async () => {
    allowAll();
    fetchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce({
      status: 403,
      headers: new Headers(),
      text: async () => "nope",
    } as unknown as Response);

    const updates = Array.from({ length: 60 }, (_, i) => ({
      externalProductId: String(i + 1),
      inStock: true,
    }));

    const result = (await pushStockStatus("int-1", updates)) as {
      status: string;
      results: Array<{ status: string }>;
    };

    // Never a bare "sent" — the caller must confront the 403.
    expect(result.status).toBe("partial");
    expect(result.results.map((r) => r.status).sort()).toEqual([
      "failed",
      "sent",
    ]);
  });

  it("STOPS mid-fan-out when the flag is flipped off between batches", async () => {
    allowAll();

    // Batch 1 gate + fence see ON; everything after sees OFF.
    db.integration.findUnique
      .mockResolvedValueOnce(integrationRow())
      .mockResolvedValueOnce(integrationRow())
      .mockResolvedValue(integrationRow({ stockSyncEnabled: false }));

    const updates = Array.from({ length: 60 }, (_, i) => ({
      externalProductId: String(i + 1),
      inStock: true,
    }));

    const result = (await pushStockStatus("int-1", updates)) as {
      results: Array<{ status: string; reason?: string }>;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.results[0].status).toBe("sent");
    expect(result.results[1].status).toBe("blocked");
    expect(result.results[1].reason).toBe("integration_flag_off");
  });

  it("splits simple products and variations into separate wire requests", async () => {
    allowAll();

    await pushStockStatus("int-1", [
      { externalProductId: "10", inStock: true },
      { externalProductId: "20", externalVariationId: "21", inStock: false },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const paths = fetchMock.mock.calls.map((c) => new URL(c[0]).pathname);
    expect(paths).toContain("/wp-json/wc/v3/products/batch");
    expect(paths).toContain("/wp-json/wc/v3/products/20/variations/batch");
  });

  it("sends nothing at all for an empty update list", async () => {
    allowAll();

    const result = (await pushStockStatus("int-1", [])) as {
      status: string;
      results: unknown[];
    };

    expect(result.status).toBe("partial");
    expect(result.results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(db.platformWriteAttempt.create).toHaveBeenCalledTimes(0);
  });
});

// ===========================================================================
// Payload discipline
// ===========================================================================

describe("what actually goes on the wire", () => {
  it("stock writes carry stock_status ONLY — never stock_quantity or manage_stock", async () => {
    allowAll();

    await pushStockStatus("int-1", [
      { externalProductId: "10", inStock: true },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ update: [{ id: 10, stock_status: "instock" }] });
    expect(JSON.stringify(body)).not.toContain("stock_quantity");
    expect(JSON.stringify(body)).not.toContain("manage_stock");
  });

  it("order-status writes carry ONLY { status }", async () => {
    allowAll();

    await pushOrderStatus("int-1", "555", "completed");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ status: "completed" });
  });

  it("uses the WRITE credential, never the read one", async () => {
    allowAll();

    await pushStockStatus("int-1", STOCK);

    const auth = fetchMock.mock.calls[0][1].headers.Authorization as string;
    const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("ck_write:cs_write");
    expect(decoded).not.toContain("ck_read");
  });

  it("never persists the request body — only its digest", async () => {
    allowAll();

    await pushStockStatus("int-1", STOCK);

    const data = db.platformWriteAttempt.create.mock.calls[0][0].data;
    expect(data.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain("ck_write");
    expect(JSON.stringify(data)).not.toContain("cs_write");
  });
});
