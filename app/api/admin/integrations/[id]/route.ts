import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange, diff, type ChangeDiff } from "@/lib/change-tracking";
import { encryptValue } from "@/lib/encryption";
import { UpdateIntegrationSchema } from "@/lib/validation/integrations";

// Only these three fields make an edit a "sync config change"; everything else
// (name, storeUrl, isActive, credentials) is a plain INTEGRATION_UPDATE.
const SYNC_CONFIG_FIELDS = new Set([
  "stockSyncEnabled",
  "fulfillmentPushEnabled",
  "syncLocationId",
]);

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
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  // Schema validates the store URL when present and strips unknown keys the edit
  // form carries (companyId, platform). Credential fields stay optional strings so
  // the "empty string = leave unchanged" behavior below is preserved.
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
  } = UpdateIntegrationSchema.parse(body);

  const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : apiKey;
  const normalizedApiSecret =
    typeof apiSecret === "string" ? apiSecret.trim() : apiSecret;
  const normalizedWebhookSecret =
    typeof webhookSecret === "string" ? webhookSecret.trim() : webhookSecret;

  // Build update data
  const updateData: any = {};

  if (name !== undefined) updateData.name = name;
  if (storeUrl !== undefined) updateData.storeUrl = storeUrl;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (typeof stockSyncEnabled === "boolean") updateData.stockSyncEnabled = stockSyncEnabled;
  if (typeof fulfillmentPushEnabled === "boolean") updateData.fulfillmentPushEnabled = fulfillmentPushEnabled;
  if (syncLocationId !== undefined) updateData.syncLocationId = syncLocationId === null ? null : Number(syncLocationId);

  // Only update encrypted fields if new values are provided (empty string ==
  // "leave unchanged"). A rotation records ONLY that it happened — never values.
  if (normalizedApiKey) {
    updateData.encryptedApiKey = encryptValue(normalizedApiKey);
  }
  if (normalizedApiSecret) {
    updateData.encryptedApiSecret = encryptValue(normalizedApiSecret);
  }
  if (normalizedWebhookSecret) {
    updateData.webhookSecret = encryptValue(normalizedWebhookSecret);
  }

  // Fetch the before-image, update, and record the diff over EXACTLY the provided
  // fields — all in ONE tx. Empty diff => no event (ER-B9).
  const integration = await prisma.$transaction(async (tx) => {
    const before = await tx.integration.findUniqueOrThrow({
      where: { id: params.id },
      select: {
        name: true,
        storeUrl: true,
        isActive: true,
        stockSyncEnabled: true,
        fulfillmentPushEnabled: true,
        syncLocationId: true,
      },
    });

    // Diff only the scalar fields the caller actually provided.
    const beforeVals: Record<string, unknown> = {};
    const afterVals: Record<string, unknown> = {};
    const providedFields: string[] = [];
    const track = (field: string, from: unknown, to: unknown) => {
      providedFields.push(field);
      beforeVals[field] = from;
      afterVals[field] = to;
    };
    if (name !== undefined) track("name", before.name, name);
    if (storeUrl !== undefined) track("storeUrl", before.storeUrl, storeUrl);
    if (isActive !== undefined) track("isActive", before.isActive, isActive);
    if (typeof stockSyncEnabled === "boolean")
      track("stockSyncEnabled", before.stockSyncEnabled, stockSyncEnabled);
    if (typeof fulfillmentPushEnabled === "boolean")
      track("fulfillmentPushEnabled", before.fulfillmentPushEnabled, fulfillmentPushEnabled);
    if (syncLocationId !== undefined)
      track(
        "syncLocationId",
        before.syncLocationId,
        syncLocationId === null ? null : Number(syncLocationId)
      );

    const changes: ChangeDiff = diff(beforeVals, afterVals, providedFields);

    // Credential rotations are recorded as denylisted keys — redactDeep collapses
    // each to "[REDACTED]"; no plaintext ever touches the event.
    if (updateData.encryptedApiKey) changes.apiKey = { from: "[REDACTED]", to: "[REDACTED]" };
    if (updateData.encryptedApiSecret)
      changes.apiSecret = { from: "[REDACTED]", to: "[REDACTED]" };
    if (updateData.webhookSecret)
      changes.webhookSecret = { from: "[REDACTED]", to: "[REDACTED]" };

    const updated = await tx.integration.update({
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

    const changedKeys = Object.keys(changes);
    if (changedKeys.length > 0) {
      const isSyncConfigOnly = changedKeys.every((k) => SYNC_CONFIG_FIELDS.has(k));
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: isSyncConfigOnly
          ? "INTEGRATION_SYNC_CONFIG_CHANGE"
          : "INTEGRATION_UPDATE",
        entityType: "INTEGRATION",
        entityId: params.id,
        companyId: updated.companyId,
        action: `Updated integration "${updated.name}"`,
        changes,
      });
    }

    return updated;
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
  const { user } = await requireAdmin();

  await requireCSRF(request);

  // Fetch the FULL row so the R-D11 snapshot captures every field (credentials
  // auto-redact to "[REDACTED]").
  const integration = await prisma.integration.findUnique({
    where: { id: params.id },
  });

  if (!integration) {
    return NextResponse.json(
      { error: "Integration not found" },
      { status: 404 }
    );
  }

  // R-D11 cascade capture: id+identity arrays (cap 1000, then count-only) plus
  // pure counts, all read INSIDE the tx BEFORE the destructive ops. salesFacts
  // cascade via the DB (P-B5 rev.) — count only, never deleteMany.
  const CASCADE_CAP = 1000;
  await prisma.$transaction(async (tx) => {
    const orderRows = await tx.externalOrder.findMany({
      where: { integrationId: params.id },
      select: { id: true, orderNumber: true },
      take: CASCADE_CAP + 1,
    });
    const productLinkRows = await tx.productLink.findMany({
      where: { integrationId: params.id },
      select: { id: true, externalProductId: true, isBundle: true },
      take: CASCADE_CAP + 1,
    });
    const orderItemsCount = await tx.externalOrderItem.count({
      where: { order: { integrationId: params.id } },
    });
    const destroyedSalesFacts = await tx.productSalesFact.count({
      where: { integrationId: params.id },
    });

    const cascade: Record<string, unknown> = {
      orders:
        orderRows.length > CASCADE_CAP
          ? await tx.externalOrder.count({ where: { integrationId: params.id } })
          : orderRows,
      productLinks:
        productLinkRows.length > CASCADE_CAP
          ? await tx.productLink.count({ where: { integrationId: params.id } })
          : productLinkRows,
      orderItems: orderItemsCount,
      destroyedSalesFacts,
    };

    // ExternalOrder has no DB cascade from Integration — delete dependents first.
    await tx.externalOrderItem.deleteMany({
      where: { order: { integrationId: params.id } },
    });
    await tx.externalOrder.deleteMany({ where: { integrationId: params.id } });
    await tx.productLink.deleteMany({ where: { integrationId: params.id } });
    await tx.integration.delete({ where: { id: params.id } });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "INTEGRATION_DELETE",
      entityType: "INTEGRATION",
      entityId: params.id,
      companyId: integration.companyId,
      action: `Deleted integration "${integration.name}"`,
      details: { snapshot: integration, cascade },
    });
  });

  return NextResponse.json({
    success: true,
    message: "Integration deleted successfully",
  });
});
