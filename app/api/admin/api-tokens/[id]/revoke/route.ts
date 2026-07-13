import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/api-tokens/[id]/revoke — revoke a token (idempotent on an
 * already-revoked token). Sets revokedAt and emits API_TOKEN_REVOKE (details =
 * name/tier only; never token or hash).
 */
export const POST = apiHandler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const { user: adminUser } = await requireAdmin();
    await requireCSRF(request);

    const id = (params.id ?? "").trim();
    if (!id) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    await prisma.$transaction(async (tx) => {
      const token = await tx.apiToken.findUnique({ where: { id } });
      if (!token) {
        throw new AppError("Token not found", "NOT_FOUND", 404);
      }
      if (token.revokedAt) {
        return; // already revoked — idempotent no-op, no duplicate event
      }

      const revokedAt = new Date();
      await tx.apiToken.update({ where: { id }, data: { revokedAt } });

      await recordChange(tx, {
        actor: { userId: adminUser.id },
        actionType: "API_TOKEN_REVOKE",
        entityType: "SETTINGS",
        entityId: id,
        action: `Revoked API token ${token.name}`,
        // Details carry name/tier ONLY — never the token or its hash (D7).
        details: { name: token.name, tier: token.tier },
      });
    });

    return NextResponse.json({ success: true });
  },
);
