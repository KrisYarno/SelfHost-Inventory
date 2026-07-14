/**
 * Lane 6 T3 — admin integration API responses are PROVABLY free of credentials.
 *
 * This is a W1 close-gate item (REV-2 #10). The old routes redacted by omission
 * (`const { encryptedApiKey: _a, ... } = row`), which fails OPEN: every secret
 * column added after the destructure was written leaks by default. Lane 6 adds
 * four such columns, which is exactly how that class of bug ships.
 *
 * The rule enforced here: the response is built from an ALLOWLIST, and the
 * allowlist is cross-checked against the schema's real secret-field list. Adding
 * a secret column to `Integration` without adding it to INTEGRATION_SECRET_FIELDS
 * fails this suite.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PUBLIC_INTEGRATION_SELECT,
  INTEGRATION_SECRET_FIELDS,
  toPublicIntegration,
  credentialStatus,
} from "@/lib/integrations/public-select";

describe("the allowlist cannot name a secret", () => {
  it("PUBLIC_INTEGRATION_SELECT and INTEGRATION_SECRET_FIELDS are disjoint", () => {
    const publicKeys = Object.keys(PUBLIC_INTEGRATION_SELECT);
    const overlap = publicKeys.filter((k) =>
      (INTEGRATION_SECRET_FIELDS as readonly string[]).includes(k)
    );
    expect(overlap).toEqual([]);
  });

  it("no allowlisted field name even LOOKS like a secret", () => {
    const suspicious = Object.keys(PUBLIC_INTEGRATION_SELECT).filter((k) =>
      /encrypted|secret|password|token|apikey/i.test(k)
    );
    expect(suspicious).toEqual([]);
  });
});

describe("INTEGRATION_SECRET_FIELDS is complete w.r.t. the Prisma schema", () => {
  // The schema is the ground truth. If someone adds `encryptedFooKey` to the
  // Integration model and forgets this list, the allowlist would still exclude
  // it from responses (good) — but credentialStatus/redaction would silently not
  // know about it. Fail loudly instead.
  it("every secret-shaped column on model Integration is enumerated", () => {
    const schema = readFileSync(
      join(process.cwd(), "prisma", "schema.prisma"),
      "utf8"
    );

    const model = schema.match(/model Integration \{([\s\S]*?)\n\}/);
    expect(model).not.toBeNull();

    const body = model![1];
    const fieldNames = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0]);

    const secretShaped = fieldNames.filter((f) =>
      /^encrypted|Secret$|^webhookSecret$/i.test(f)
    );

    // Every secret-shaped field in the schema must be declared as such.
    const undeclared = secretShaped.filter(
      (f) => !(INTEGRATION_SECRET_FIELDS as readonly string[]).includes(f)
    );
    expect(undeclared).toEqual([]);

    // Sanity: we actually found the Lane 6 split columns (guards against the
    // regex silently matching nothing and the test passing vacuously).
    expect(secretShaped).toEqual(
      expect.arrayContaining([
        "encryptedWriteKey",
        "encryptedWriteSecret",
        "encryptedReadKey",
        "encryptedReadSecret",
        "webhookSecret",
      ])
    );
  });
});

describe("toPublicIntegration builds by construction, not by filtering", () => {
  const rowWithSecrets = {
    id: "int_1",
    companyId: "co_1",
    platform: "WOOCOMMERCE",
    name: "Awake",
    storeUrl: "https://store.example.com",
    isActive: true,
    stockSyncEnabled: true,
    fulfillmentPushEnabled: false,
    // The material that must never escape:
    encryptedWriteKey: "ENC(ck_live_write)",
    encryptedWriteSecret: "ENC(cs_live_write)",
    encryptedReadKey: "ENC(ck_live_read)",
    encryptedReadSecret: "ENC(cs_live_read)",
    webhookSecret: "ENC(whsec)",
    // A hypothetical FUTURE secret column nobody remembered to deny:
    encryptedFutureThing: "ENC(tomorrows_leak)",
  };

  it("omits every encrypted field", () => {
    const out = toPublicIntegration(rowWithSecrets);
    for (const field of INTEGRATION_SECRET_FIELDS) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it("omits a NEW secret column it has never heard of (fails closed)", () => {
    // This is the whole point. A denylist would have shipped this value.
    const out = toPublicIntegration(rowWithSecrets);
    expect(out).not.toHaveProperty("encryptedFutureThing");
    expect(JSON.stringify(out)).not.toContain("tomorrows_leak");
  });

  it("carries no ciphertext anywhere in the serialized payload", () => {
    const serialized = JSON.stringify(toPublicIntegration(rowWithSecrets));
    expect(serialized).not.toContain("ENC(");
    expect(serialized).not.toContain("ck_live");
    expect(serialized).not.toContain("cs_live");
    expect(serialized).not.toContain("whsec");
  });

  it("still carries the fields the admin UI needs", () => {
    const out = toPublicIntegration(rowWithSecrets);
    expect(out.id).toBe("int_1");
    expect(out.name).toBe("Awake");
    expect(out.storeUrl).toBe("https://store.example.com");
    expect(out.stockSyncEnabled).toBe(true);
  });
});

describe("credentialStatus ships booleans, never material", () => {
  it("reports presence of each pair", () => {
    expect(
      credentialStatus({
        encryptedWriteKey: "k",
        encryptedWriteSecret: "s",
        encryptedReadKey: null,
        encryptedReadSecret: null,
        webhookSecret: "w",
      })
    ).toEqual({
      hasWriteCredential: true,
      hasReadCredential: false,
      hasWebhookSecret: true,
    });
  });

  it("a half-populated pair is NOT present", () => {
    const status = credentialStatus({
      encryptedWriteKey: "k",
      encryptedWriteSecret: null,
      encryptedReadKey: null,
      encryptedReadSecret: null,
      webhookSecret: null,
    });
    expect(status.hasWriteCredential).toBe(false);
  });

  it("returns only booleans", () => {
    const status = credentialStatus({
      encryptedWriteKey: "supersecret",
      encryptedWriteSecret: "supersecret",
      encryptedReadKey: "supersecret",
      encryptedReadSecret: "supersecret",
      webhookSecret: "supersecret",
    });
    for (const v of Object.values(status)) {
      expect(typeof v).toBe("boolean");
    }
    expect(JSON.stringify(status)).not.toContain("supersecret");
  });
});
