/**
 * Lane 6 T3 — the credential chokepoint (R-E8).
 *
 * The load-bearing assertion in this file: scope "write" has NO fallback. A read
 * path can never accidentally hold a write-capable key, and a write can never
 * borrow a read key to "make it work".
 */

import {
  resolveCredentials,
  resolveFromRow,
  hasWriteCredential,
  hasReadCredential,
  credentialFingerprint,
} from "@/lib/platforms/egress/credentials";
import prisma from "@/lib/prisma";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { integration: { findUnique: jest.fn() } },
}));

// Plaintext passthrough: isEncrypted() is false for these, so decryptValue is
// never invoked. Keeps the test about RESOLUTION RULES, not about crypto.
jest.mock("@/lib/encryption", () => ({
  __esModule: true,
  isEncrypted: jest.fn((v: string) => v.startsWith("ENC(")),
  decryptValue: jest.fn((v: string) => {
    if (v === "ENC(boom)") throw new Error("bad key");
    return v.slice(4, -1);
  }),
}));

const mockPrisma = prisma as unknown as {
  integration: { findUnique: jest.Mock };
};

const row = (over: Partial<Record<string, string | null>> = {}) => ({
  storeUrl: "https://store.example.com",
  encryptedReadKey: null,
  encryptedReadSecret: null,
  encryptedWriteKey: null,
  encryptedWriteSecret: null,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("scope=write — NEVER falls back (the core of R-E8)", () => {
  it("returns the write pair when present", () => {
    const r = resolveFromRow(
      row({ encryptedWriteKey: "wk", encryptedWriteSecret: "ws" }),
      "write"
    );
    expect(r).toEqual({
      storeUrl: "https://store.example.com",
      key: "wk",
      secret: "ws",
      usedWriteFallback: false,
    });
  });

  it("returns NULL when encryptedWriteKey is absent — even if a READ pair exists", () => {
    // The hazard: a write borrowing the read key would send an authenticated
    // request that Woo rejects... or, if the "read" key were mis-provisioned as
    // read-write, would SUCCEED. Never fall back.
    const r = resolveFromRow(
      row({ encryptedReadKey: "rk", encryptedReadSecret: "rs" }),
      "write"
    );
    expect(r).toBeNull();
  });

  it("returns NULL when only half the write pair is present", () => {
    expect(
      resolveFromRow(row({ encryptedWriteKey: "wk" }), "write")
    ).toBeNull();
    expect(
      resolveFromRow(row({ encryptedWriteSecret: "ws" }), "write")
    ).toBeNull();
  });

  it("returns NULL (never throws) when the write credential fails to decrypt", () => {
    const r = resolveFromRow(
      row({ encryptedWriteKey: "ENC(boom)", encryptedWriteSecret: "ws" }),
      "write"
    );
    expect(r).toBeNull();
  });
});

describe("scope=read", () => {
  it("prefers the dedicated read pair", () => {
    const r = resolveFromRow(
      row({
        encryptedReadKey: "rk",
        encryptedReadSecret: "rs",
        encryptedWriteKey: "wk",
        encryptedWriteSecret: "ws",
      }),
      "read"
    );
    expect(r?.key).toBe("rk");
    expect(r?.secret).toBe("rs");
    expect(r?.usedWriteFallback).toBe(false);
  });

  it("falls back to the write pair ONLY while no read key exists (migration grace)", () => {
    const r = resolveFromRow(
      row({ encryptedWriteKey: "wk", encryptedWriteSecret: "ws" }),
      "read"
    );
    expect(r?.key).toBe("wk");
    // Flagged, so health can nag until Kris provisions read-only keys in Woo.
    expect(r?.usedWriteFallback).toBe(true);
  });

  it("returns null when neither pair exists", () => {
    expect(resolveFromRow(row(), "read")).toBeNull();
  });

  it("decrypts encrypted values", () => {
    const r = resolveFromRow(
      row({ encryptedReadKey: "ENC(rk)", encryptedReadSecret: "ENC(rs)" }),
      "read"
    );
    expect(r?.key).toBe("rk");
    expect(r?.secret).toBe("rs");
  });
});

describe("resolveCredentials (DB-backed)", () => {
  it("returns null when the integration does not exist", async () => {
    mockPrisma.integration.findUnique.mockResolvedValue(null);
    expect(await resolveCredentials("nope", "write")).toBeNull();
  });

  it("selects ONLY credential columns — never the whole row", async () => {
    mockPrisma.integration.findUnique.mockResolvedValue(
      row({ encryptedWriteKey: "wk", encryptedWriteSecret: "ws" })
    );
    await resolveCredentials("int_1", "write");

    const select = mockPrisma.integration.findUnique.mock.calls[0][0].select;
    expect(select).toEqual({
      storeUrl: true,
      encryptedReadKey: true,
      encryptedReadSecret: true,
      encryptedWriteKey: true,
      encryptedWriteSecret: true,
    });
  });
});

describe("presence predicates (used by the gate without decrypting)", () => {
  it("hasWriteCredential requires BOTH halves", () => {
    expect(
      hasWriteCredential({ encryptedWriteKey: "k", encryptedWriteSecret: "s" })
    ).toBe(true);
    expect(
      hasWriteCredential({ encryptedWriteKey: "k", encryptedWriteSecret: null })
    ).toBe(false);
    expect(
      hasWriteCredential({ encryptedWriteKey: null, encryptedWriteSecret: null })
    ).toBe(false);
  });

  it("hasReadCredential requires BOTH halves", () => {
    expect(
      hasReadCredential({ encryptedReadKey: "k", encryptedReadSecret: "s" })
    ).toBe(true);
    expect(
      hasReadCredential({ encryptedReadKey: null, encryptedReadSecret: "s" })
    ).toBe(false);
  });
});

describe("credentialFingerprint (REV-2 #4 fence input)", () => {
  it("changes when the key rotates", () => {
    const a = credentialFingerprint({
      encryptedWriteKey: "k1",
      encryptedWriteSecret: "s",
    });
    const b = credentialFingerprint({
      encryptedWriteKey: "k2",
      encryptedWriteSecret: "s",
    });
    expect(a).not.toBe(b);
  });

  it("is stable and never contains the key material", () => {
    const f = credentialFingerprint({
      encryptedWriteKey: "supersecret",
      encryptedWriteSecret: "alsosecret",
    });
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(f).not.toContain("supersecret");
  });
});
