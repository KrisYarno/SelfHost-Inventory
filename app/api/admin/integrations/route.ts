import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { encryptValue } from "@/lib/encryption";
import { CreateIntegrationSchema } from "@/lib/validation/integrations";
import {
  PUBLIC_INTEGRATION_SELECT,
  CREDENTIAL_PRESENCE_SELECT,
  credentialStatus,
  toPublicIntegration,
} from "@/lib/integrations/public-select";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/integrations
 * List all integrations (admin only).
 *
 * REV-2 #10: the field set is an explicit ALLOWLIST (PUBLIC_INTEGRATION_SELECT).
 * Credential material is never selected; only presence BOOLEANS are derived, so
 * the admin UI can show "write key on file / no read key yet" without the
 * ciphertext ever crossing the wire.
 */
export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAdmin();

  const rows = await prisma.integration.findMany({
    select: {
      ...PUBLIC_INTEGRATION_SELECT,
      ...CREDENTIAL_PRESENCE_SELECT,
      company: {
        select: {
          name: true,
          slug: true,
        },
      },
    },
    orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
  });

  // Built by construction from the allowlist — never by stripping a full row.
  const integrations = rows.map((row) => ({
    ...toPublicIntegration(row),
    credentials: credentialStatus(row),
  }));

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
  // Schema trims the identity + credential fields, enforces the platform enum,
  // and validates the store URL (same "Invalid store URL" message as before).
  const {
    companyId,
    platform,
    name,
    storeUrl: normalizedStoreUrl,
    writeKey: normalizedWriteKey,
    writeSecret: normalizedWriteSecret,
    readKey: normalizedReadKey,
    readSecret: normalizedReadSecret,
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

  // Encrypt credentials before storing (R-E8: two independent pairs).
  const encryptedWriteKey = encryptValue(normalizedWriteKey);
  const encryptedWriteSecret = encryptValue(normalizedWriteSecret);
  // The read pair is optional at create — an absent one falls back to the write
  // pair for reads (migration grace) and health warns until it is provisioned.
  const encryptedReadKey = normalizedReadKey
    ? encryptValue(normalizedReadKey)
    : null;
  const encryptedReadSecret = normalizedReadSecret
    ? encryptValue(normalizedReadSecret)
    : null;
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
        encryptedWriteKey,
        encryptedWriteSecret,
        encryptedReadKey,
        encryptedReadSecret,
        webhookSecret: encryptedWebhookSecret,
        isActive: true,
      },
      // Allowlist select: the created row that leaves this handler provably
      // cannot carry the credentials we just encrypted (REV-2 #10).
      select: {
        ...PUBLIC_INTEGRATION_SELECT,
        company: { select: { name: true, slug: true } },
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

  return NextResponse.json(
    {
      integration: {
        ...toPublicIntegration(integration),
        credentials: {
          hasWriteCredential: true,
          hasReadCredential: !!encryptedReadKey && !!encryptedReadSecret,
          hasWebhookSecret: !!encryptedWebhookSecret,
        },
      },
    },
    { status: 201 }
  );
});
