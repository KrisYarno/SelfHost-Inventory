/**
 * mcp/src/auth.ts — static-Bearer token authentication for the MCP sidecar
 * (spec D7/D8, normative per codex #17).
 *
 * Flow (ANY failure -> generic 401, no detail leaked):
 *   Authorization: Bearer invmcp_<base64url(32 bytes)>
 *     -> validate the `invmcp_` prefix + base64url shape (43 chars, no padding)
 *     -> sha256 hex digest of the FULL token string
 *     -> prisma.apiToken lookup by the UNIQUE tokenHash index (O(1))
 *     -> compare stored vs computed digests as fixed-length Buffers via
 *        crypto.timingSafeEqual (constant time; defence-in-depth over the
 *        unique-index match)
 *     -> lifecycle: revokedAt IS NULL; owner deletedAt IS NULL AND isApproved
 *     -> { tokenId, ownerUserId, isAdmin }
 *   lastUsedAt is updated best-effort (fire-and-forget; never blocks or throws).
 *
 * MUST stay Next-free (imports only the Prisma singleton + node:crypto).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";

const TOKEN_PREFIX = "invmcp_";
/** base64url(randomBytes(32)) is exactly 43 chars, unpadded (spec D7). */
const BASE64URL_BODY = /^[A-Za-z0-9_-]{43}$/;

export interface AuthenticatedToken {
  tokenId: string;
  ownerUserId: number;
  isAdmin: boolean;
}

export type AuthResult = { ok: true; token: AuthenticatedToken } | { ok: false };

const FAIL: AuthResult = { ok: false };

/** Extract the raw token from an `Authorization: Bearer <token>` header value. */
export function extractBearer(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer[ \t]+(\S+)$/.exec(value.trim());
  return match ? match[1] : null;
}

/** sha256 hex digest of the full token string (unsalted; adequate for 256-bit
 *  server-generated entropy per codex F13). */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Constant-time equality of two hex digest strings. Different-length (or empty)
 * inputs are unequal WITHOUT calling timingSafeEqual (which throws on length
 * mismatch). Equal-length inputs are compared as fixed-length Buffers via
 * crypto.timingSafeEqual — this is the D7-normative comparison.
 */
export function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length || aHex.length === 0) return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Authenticate a Bearer header into a token identity, or fail generically.
 * Never throws — a DB error during lookup is swallowed into a 401 (no detail).
 */
export async function authenticateToken(
  header: string | string[] | undefined,
): Promise<AuthResult> {
  const raw = extractBearer(header);
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return FAIL;

  const body = raw.slice(TOKEN_PREFIX.length);
  if (!BASE64URL_BODY.test(body)) return FAIL;

  const digest = hashToken(raw);

  let record: {
    id: string;
    tokenHash: string;
    revokedAt: Date | null;
    ownerUserId: number;
    owner: { isAdmin: boolean; isApproved: boolean; deletedAt: Date | null } | null;
  } | null;
  try {
    record = await prisma.apiToken.findUnique({
      where: { tokenHash: digest },
      select: {
        id: true,
        tokenHash: true,
        revokedAt: true,
        ownerUserId: true,
        owner: { select: { isAdmin: true, isApproved: true, deletedAt: true } },
      },
    });
  } catch (err) {
    console.error("[mcp-auth] token lookup failed (treated as unauthorized)", err);
    return FAIL;
  }

  if (!record) return FAIL;
  if (!timingSafeHexEqual(record.tokenHash, digest)) return FAIL;
  if (record.revokedAt !== null) return FAIL;

  const owner = record.owner;
  if (!owner || owner.deletedAt !== null || owner.isApproved !== true) return FAIL;

  // Best-effort lastUsedAt — fire-and-forget, never blocks the request or throws.
  void prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    ok: true,
    token: { tokenId: record.id, ownerUserId: record.ownerUserId, isAdmin: owner.isAdmin },
  };
}
