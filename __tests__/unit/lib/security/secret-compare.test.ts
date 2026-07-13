import {
  timingSafeStringEqual,
  bearerAuthorized,
  headerTokenAuthorized,
} from "@/lib/security/secret-compare";

describe("timingSafeStringEqual", () => {
  test("equal same-length strings => true", () => {
    expect(timingSafeStringEqual("abc123", "abc123")).toBe(true);
  });

  test("unequal same-length strings => false", () => {
    expect(timingSafeStringEqual("abc123", "abc124")).toBe(false);
  });

  test("different-length strings => false (length is not secret)", () => {
    expect(timingSafeStringEqual("short", "longersecret")).toBe(false);
  });

  test("both empty => true", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  test("one empty => false", () => {
    expect(timingSafeStringEqual("", "x")).toBe(false);
    expect(timingSafeStringEqual("x", "")).toBe(false);
  });

  test("multibyte-safe (utf8 buffers, equal)", () => {
    expect(timingSafeStringEqual("café", "café")).toBe(true);
  });
});

describe("bearerAuthorized", () => {
  const secret = "s3cr3t-token";

  test("exact `Bearer <secret>` => true", () => {
    expect(bearerAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  test("wrong secret => false", () => {
    expect(bearerAuthorized(`Bearer wrong-token`, secret)).toBe(false);
  });

  test("secret unset => false", () => {
    expect(bearerAuthorized(`Bearer ${secret}`, undefined)).toBe(false);
  });

  test("secret empty string => false", () => {
    expect(bearerAuthorized(`Bearer `, "")).toBe(false);
  });

  test("null header => false", () => {
    expect(bearerAuthorized(null, secret)).toBe(false);
  });

  test("missing `Bearer ` prefix => false", () => {
    expect(bearerAuthorized(secret, secret)).toBe(false);
  });

  test("wrong-case prefix => false", () => {
    expect(bearerAuthorized(`bearer ${secret}`, secret)).toBe(false);
  });

  test("extra leading whitespace => false", () => {
    expect(bearerAuthorized(`  Bearer ${secret}`, secret)).toBe(false);
  });

  test("extra whitespace between prefix and token => false", () => {
    expect(bearerAuthorized(`Bearer  ${secret}`, secret)).toBe(false);
  });

  test("token with trailing whitespace => false", () => {
    expect(bearerAuthorized(`Bearer ${secret} `, secret)).toBe(false);
  });
});

describe("headerTokenAuthorized", () => {
  const secret = "internal-sync-token";

  test("exact raw token match => true", () => {
    expect(headerTokenAuthorized(secret, secret)).toBe(true);
  });

  test("wrong token => false", () => {
    expect(headerTokenAuthorized("nope", secret)).toBe(false);
  });

  test("secret unset => false", () => {
    expect(headerTokenAuthorized(secret, undefined)).toBe(false);
  });

  test("secret empty => false", () => {
    expect(headerTokenAuthorized("", "")).toBe(false);
  });

  test("null header => false", () => {
    expect(headerTokenAuthorized(null, secret)).toBe(false);
  });

  test("length-mismatch token => false (no throw)", () => {
    expect(headerTokenAuthorized("x", secret)).toBe(false);
  });
});
