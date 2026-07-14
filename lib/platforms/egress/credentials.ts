/**
 * lib/platforms/egress/credentials.ts — the credential chokepoint (D-E7, R-E8).
 *
 * PRIVATE to lib/platforms/egress/. This module is NOT exported from the package
 * barrel (`index.ts`) and importing it from outside `lib/platforms/egress/` is a
 * CI failure (see __tests__/integration/lane6-egress-enforcement.test.ts).
 *
 * WHY THIS EXISTS (R-E8, and it is the compensating control for R-D1):
 * WooCommerce API keys carry Read / Write / Read-Write permission — NOT
 * per-endpoint scope. A write-capable key can write ORDERS. The owner chose to
 * keep write-capable keys on both stores, so the CREDENTIAL cannot be the
 * guarantee; the software must be. Splitting the pair is what recovers most of
 * it: every read path resolves ONLY the read credential and is therefore
 * physically incapable of mutating the store, no matter what bug, refactor, or
 * AI edit lands in it. Only `pushStockStatus` / `pushOrderStatus` may ask for
 * scope "write".
 */

import { createHash } from "node:crypto";

import { decryptValue, isEncrypted } from "@/lib/encryption";
import prisma from "@/lib/prisma";

export type CredentialScope = "read" | "write";

export interface ResolvedCredentials {
  storeUrl: string;
  key: string;
  secret: string;
  /**
   * True when a READ resolved to the write-capable pair because no read key is
   * provisioned yet (migration grace). Health warns on this; it is never allowed
   * for scope "write" (which has no fallback at all).
   */
  usedWriteFallback: boolean;
}

/** Row shape the resolver needs. Selected explicitly — never `include: true`. */
export interface CredentialRow {
  storeUrl: string;
  encryptedReadKey: string | null;
  encryptedReadSecret: string | null;
  encryptedWriteKey: string | null;
  encryptedWriteSecret: string | null;
}

/**
 * Decrypt-or-passthrough. Returns null on ANY failure — a decrypt error must
 * never throw plaintext (or a stack carrying it) into logs, and a null here
 * fails the caller closed.
 */
function decryptOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    if (!isEncrypted(value)) return value;
    const plain = decryptValue(value);
    return plain && plain.length > 0 ? plain : null;
  } catch {
    // Deliberately swallow: the error object can carry key material.
    console.error("[egress] credential decrypt failed (check ENCRYPTION_KEY)");
    return null;
  }
}

/**
 * True when the integration has a write-capable credential pair on file. Used by
 * the gate to answer `no_write_credential` WITHOUT decrypting anything.
 */
export function hasWriteCredential(row: {
  encryptedWriteKey: string | null;
  encryptedWriteSecret: string | null;
}): boolean {
  return !!row.encryptedWriteKey && !!row.encryptedWriteSecret;
}

/** True when a dedicated read credential is provisioned (health warns if not). */
export function hasReadCredential(row: {
  encryptedReadKey: string | null;
  encryptedReadSecret: string | null;
}): boolean {
  return !!row.encryptedReadKey && !!row.encryptedReadSecret;
}

/**
 * Resolve credentials for a scope.
 *
 * READ  — prefers the dedicated read pair. Falls back to the write pair ONLY
 *         while an integration has no read key yet (migration grace, health
 *         warns). Without this grace every read would break the moment the
 *         rename lands, before Kris has provisioned read-only keys in Woo.
 * WRITE — NEVER falls back. No write pair => null => `no_write_credential`.
 *
 * Returns null (never throws) on a missing integration or a decrypt failure.
 */
export async function resolveCredentials(
  integrationId: string,
  scope: CredentialScope
): Promise<ResolvedCredentials | null> {
  const row = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: {
      storeUrl: true,
      encryptedReadKey: true,
      encryptedReadSecret: true,
      encryptedWriteKey: true,
      encryptedWriteSecret: true,
    },
  });

  if (!row) return null;
  return resolveFromRow(row, scope);
}

/**
 * Same rules, against an already-loaded row. The gate reads the integration once
 * (freshly) and hands the row here, so a write does not issue two queries for
 * the same record between the gate and the send.
 */
export function resolveFromRow(
  row: CredentialRow,
  scope: CredentialScope
): ResolvedCredentials | null {
  if (scope === "write") {
    // No fallback. Ever. This is the whole point of the split.
    const key = decryptOrNull(row.encryptedWriteKey);
    const secret = decryptOrNull(row.encryptedWriteSecret);
    if (!key || !secret) return null;
    return { storeUrl: row.storeUrl, key, secret, usedWriteFallback: false };
  }

  const readKey = decryptOrNull(row.encryptedReadKey);
  const readSecret = decryptOrNull(row.encryptedReadSecret);
  if (readKey && readSecret) {
    return {
      storeUrl: row.storeUrl,
      key: readKey,
      secret: readSecret,
      usedWriteFallback: false,
    };
  }

  // Migration grace: no read pair provisioned yet.
  const writeKey = decryptOrNull(row.encryptedWriteKey);
  const writeSecret = decryptOrNull(row.encryptedWriteSecret);
  if (writeKey && writeSecret) {
    return {
      storeUrl: row.storeUrl,
      key: writeKey,
      secret: writeSecret,
      usedWriteFallback: true,
    };
  }

  return null;
}

/**
 * A non-reversible fingerprint of the credential in use. Goes into the
 * authorization row's config fingerprint (REV-2 #4) so a key ROTATION between
 * authorization and send is detected as a config change — without ever storing
 * the key.
 */
export function credentialFingerprint(row: {
  encryptedWriteKey: string | null;
  encryptedWriteSecret: string | null;
}): string {
  // The ciphertext is already non-reversible without ENCRYPTION_KEY; we hash it
  // anyway so nothing key-derived is ever persisted in the attempt row.
  const material = `${row.encryptedWriteKey ?? ""}::${row.encryptedWriteSecret ?? ""}`;
  return createHash("sha256").update(material).digest("hex");
}
