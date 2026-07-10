import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { encryptValue } from "@/lib/encryption";
import { CreateIntegrationSchema } from "@/lib/validation/integrations";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/integrations
 * List all integrations (admin only)
 */
export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAdmin();

  // Fetch all integrations with company info
  const integrations = await prisma.integration.findMany({
    select: {
      id: true,
      companyId: true,
      platform: true,
      name: true,
      storeUrl: true,
      isActive: true,
      lastSyncAt: true,
      createdAt: true,
      updatedAt: true,
      stockSyncEnabled: true,
      fulfillmentPushEnabled: true,
      lastStockSyncAt: true,
      lastStockSyncError: true,
      lastWebhookReceivedAt: true,
      lastWebhookError: true,
      webhookFailureCount: true,
      company: {
        select: {
          name: true,
          slug: true,
        },
      },
    },
    orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
  });

  return NextResponse.json({ integrations });
});

/**
 * POST /api/admin/integrations
 * Create new integration (encrypt credentials)
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  // Schema trims name/storeUrl/apiKey/apiSecret, enforces the platform enum, and
  // validates the store URL (same "Invalid store URL" message as before).
  const {
    companyId,
    platform,
    name,
    storeUrl: normalizedStoreUrl,
    apiKey: normalizedApiKey,
    apiSecret: normalizedApiSecret,
    webhookSecret,
  } = CreateIntegrationSchema.parse(body);

  const normalizedWebhookSecret =
    typeof webhookSecret === "string" ? webhookSecret.trim() : webhookSecret;

  // Check if company exists
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });

  if (!company) {
    return NextResponse.json(
      { error: "Company not found" },
      { status: 404 }
    );
  }

  const resolvedWebhookSecret =
    typeof normalizedWebhookSecret === "string" &&
    normalizedWebhookSecret.length > 0
      ? normalizedWebhookSecret
      : platform === "SHOPIFY"
        ? null
        : process.env.WOOCOMMERCE_WEBHOOK_SECRET;

  if (!resolvedWebhookSecret) {
    if (platform === "WOOCOMMERCE") {
      return NextResponse.json(
        {
          error:
            "Webhook secret is required for WooCommerce integrations (or set WOOCOMMERCE_WEBHOOK_SECRET).",
        },
        { status: 400 }
      );
    }
  }

  // Encrypt credentials before storing
  const encryptedApiKey = encryptValue(normalizedApiKey);
  const encryptedApiSecret = encryptValue(normalizedApiSecret);
  const encryptedWebhookSecret =
    typeof resolvedWebhookSecret === "string"
      ? encryptValue(resolvedWebhookSecret)
      : null;

  // Create integration + INTEGRATION_CREATE audit in ONE tx. The snapshot carries
  // ONLY non-credential identity fields — credential material is never recorded,
  // even pre-redaction (R-D11 create-state).
  const integration = await prisma.$transaction(async (tx) => {
    const created = await tx.integration.create({
      data: {
        companyId,
        platform,
        name,
        storeUrl: normalizedStoreUrl,
        encryptedApiKey,
        encryptedApiSecret,
        webhookSecret: encryptedWebhookSecret,
        isActive: true,
      },
      include: {
        company: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "INTEGRATION_CREATE",
      entityType: "INTEGRATION",
      entityId: created.id,
      companyId,
      action: `Created integration "${name}" (${platform})`,
      details: { snapshot: { name, platform, storeUrl: normalizedStoreUrl } },
    });

    return created;
  });

  return NextResponse.json({ integration }, { status: 201 });
});
