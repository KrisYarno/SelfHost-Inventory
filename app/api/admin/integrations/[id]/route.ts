import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { encryptValue } from "@/lib/encryption";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/integrations/[id]
 * Get single integration (admin only)
 */
export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  await requireAdmin();

  const integration = await prisma.integration.findUnique({
    where: { id: params.id },
    include: {
      company: {
        select: {
          name: true,
          slug: true,
        },
      },
      _count: {
        select: {
          orders: true,
          productLinks: true,
        },
      },
    },
  });

  if (!integration) {
    return NextResponse.json(
      { error: "Integration not found" },
      { status: 404 }
    );
  }

  // Don't return encrypted credentials in GET
  const { encryptedApiKey: _encryptedApiKey, encryptedApiSecret: _encryptedApiSecret, webhookSecret: _webhookSecret, ...safeData } =
    integration;

  return NextResponse.json({ integration: safeData });
});

/**
 * PUT /api/admin/integrations/[id]
 * Update integration
 */
export const PUT = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  await requireAdmin();

  const body = await request.json();
  const {
    name,
    storeUrl,
    apiKey,
    apiSecret,
    webhookSecret,
    isActive,
    stockSyncEnabled,
    fulfillmentPushEnabled,
    syncLocationId,
  } = body;

  const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : apiKey;
  const normalizedApiSecret =
    typeof apiSecret === "string" ? apiSecret.trim() : apiSecret;
  const normalizedWebhookSecret =
    typeof webhookSecret === "string" ? webhookSecret.trim() : webhookSecret;

  // Validate URL if provided
  if (storeUrl) {
    try {
      new URL(storeUrl);
    } catch {
      return NextResponse.json(
        { error: "Invalid store URL" },
        { status: 400 }
      );
    }
  }

  // Build update data
  const updateData: any = {};

  if (name !== undefined) updateData.name = name;
  if (storeUrl !== undefined) updateData.storeUrl = storeUrl;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (typeof stockSyncEnabled === "boolean") updateData.stockSyncEnabled = stockSyncEnabled;
  if (typeof fulfillmentPushEnabled === "boolean") updateData.fulfillmentPushEnabled = fulfillmentPushEnabled;
  if (syncLocationId !== undefined) updateData.syncLocationId = syncLocationId === null ? null : Number(syncLocationId);

  // Only update encrypted fields if new values are provided
  if (normalizedApiKey) {
    updateData.encryptedApiKey = encryptValue(normalizedApiKey);
  }
  if (normalizedApiSecret) {
    updateData.encryptedApiSecret = encryptValue(normalizedApiSecret);
  }
  if (normalizedWebhookSecret) {
    updateData.webhookSecret = encryptValue(normalizedWebhookSecret);
  }

  // Update integration
  const integration = await prisma.integration.update({
    where: { id: params.id },
    data: updateData,
    include: {
      company: {
        select: {
          name: true,
          slug: true,
        },
      },
    },
  });

  // Don't return encrypted credentials
  const { encryptedApiKey: _encryptedApiKey, encryptedApiSecret: _encryptedApiSecret, webhookSecret: _whs, ...safeData } =
    integration;

  return NextResponse.json({ integration: safeData });
});

/**
 * DELETE /api/admin/integrations/[id]
 * Delete integration (and all associated data via cascade)
 */
export const DELETE = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  await requireAdmin();

  // Check if integration exists
  const integration = await prisma.integration.findUnique({
    where: { id: params.id },
    include: {
      _count: {
        select: {
          orders: true,
          productLinks: true,
        },
      },
    },
  });

  if (!integration) {
    return NextResponse.json(
      { error: "Integration not found" },
      { status: 404 }
    );
  }

  // Delete integration and dependents.
  await prisma.$transaction(async (tx) => {
    await tx.externalOrderItem.deleteMany({
      where: { order: { integrationId: params.id } },
    });
    await tx.externalOrder.deleteMany({ where: { integrationId: params.id } });
    await tx.productLink.deleteMany({ where: { integrationId: params.id } });
    await tx.integration.delete({ where: { id: params.id } });
  });

  return NextResponse.json({
    success: true,
    message: "Integration deleted successfully",
  });
});
