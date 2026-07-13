import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateTokenSchema = z.object({
  name: z.string().trim().min(1).max(64),
  ownerUserId: z.number().int().positive(),
});

/** Company-access label for a token owner (D-B9 "access" column). */
function accessLabel(owner: { isAdmin: boolean; _count: { companies: number } }): string {
  if (owner.isAdmin) return "All companies";
  const n = owner._count.companies;
  return n === 1 ? "1 company" : `${n} companies`;
}

/**
 * GET /api/admin/api-tokens — the token list (active first, revoked muted
 * below is a UI concern) plus the eligible owners (approved, active users) for
 * the inline create form. NEVER returns token/hash material.
 */
export const GET = apiHandler(async () => {
  await requireAdmin();

  const [rows, owners] = await Promise.all([
    prisma.apiToken.findMany({
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            email: true,
            isAdmin: true,
            _count: { select: { companies: true } },
          },
        },
      },
    }),
    prisma.user.findMany({
      where: { isApproved: true, deletedAt: null },
      select: { id: true, username: true, email: true },
      orderBy: { username: "asc" },
    }),
  ]);

  const tokens = rows.map((t) => ({
    id: t.id,
    name: t.name,
    tier: t.tier,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    status: t.revokedAt ? "revoked" : "active",
    owner: { id: t.owner.id, username: t.owner.username, email: t.owner.email },
    access: accessLabel(t.owner),
  }));

  return NextResponse.json({ tokens, owners });
});

/**
 * POST /api/admin/api-tokens — mint a read-tier token for an approved, active
 * owner. The plaintext (`invmcp_` + base64url(randomBytes(32))) is returned
 * ONCE with `Cache-Control: no-store`; only its sha256 hex digest is stored.
 * Emits API_TOKEN_CREATE (details = name/tier only; never token or hash).
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user: adminUser } = await requireAdmin();
  await requireCSRF(request);

  const { name, ownerUserId } = CreateTokenSchema.parse(await request.json());

  // Owner must be an approved, active user at creation.
  const owner = await prisma.user.findUnique({
    where: { id: ownerUserId },
    select: { id: true, username: true, email: true, isApproved: true, deletedAt: true },
  });
  if (!owner || !owner.isApproved || owner.deletedAt) {
    throw new AppError("Owner must be an approved, active user", "INVALID_OWNER", 400);
  }

  const plaintext = `invmcp_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(plaintext).digest("hex");

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.apiToken.create({
      data: {
        name,
        tokenHash,
        tier: "read",
        ownerUserId: owner.id,
        createdByUserId: adminUser.id,
      },
    });

    await recordChange(tx, {
      actor: { userId: adminUser.id },
      actionType: "API_TOKEN_CREATE",
      entityType: "SETTINGS",
      entityId: row.id,
      action: `Created API token ${name}`,
      // Details carry name/tier only — never the token or its hash (D7).
      details: { name, tier: "read", ownerUserId: owner.id },
    });

    return row;
  });

  return NextResponse.json(
    {
      // The plaintext is shown exactly once.
      token: plaintext,
      id: created.id,
      name: created.name,
      tier: created.tier,
      createdAt: created.createdAt.toISOString(),
      owner: { id: owner.id, username: owner.username, email: owner.email },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
