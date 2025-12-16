import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import { decryptValue, isEncrypted } from "@/lib/encryption";
import type { PlatformType } from "@/lib/platforms/core/types";
import type { Prisma } from "@prisma/client";
import { createHash, createHmac } from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Webhook receiver endpoint for e-commerce platform orders
 * POST /api/webhooks/[integrationId]
 *
 * This endpoint:
 * 1. Looks up Integration by ID from database
 * 2. Uses platform adapter to verify webhook signature
 * 3. Parses order using adapter.parseOrderWebhook()
 * 4. Upserts ExternalOrder and ExternalOrderItem records
 * 5. Tries to auto-map items using existing ProductLink records
 * 6. Returns 200 OK
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { integrationId: string } }
) {
  const integrationId = params.integrationId;

  try {
    // Read body as bytes FIRST (before JSON parsing) for HMAC verification
    const rawBodyBuffer = Buffer.from(await request.arrayBuffer());
    const rawBodyText = rawBodyBuffer.toString("utf8");

    // 1. Look up Integration by ID from database
    const integration = await prisma.integration.findUnique({
      where: { id: integrationId },
      include: {
        company: true,
      },
    });

    if (!integration) {
      console.error(`Integration not found: ${integrationId}`);
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    if (!integration.isActive) {
      console.error(`Integration is inactive: ${integrationId}`);
      return NextResponse.json(
        { error: "Integration is inactive" },
        { status: 403 }
      );
    }

    // 2. Use platform adapter to verify webhook signature
    const platform = integration.platform as PlatformType;
    const adapter = getPlatformAdapter(platform);

    // Extract webhook headers
    const webhookHeaders = adapter.extractWebhookHeaders(request.headers);

    // Resolve webhook secret (DB first, then safe fallbacks)
    const resolved = resolveWebhookSecret(integration, platform);

    if (!resolved) {
      console.error(`Integration missing webhook secret: ${integrationId}`);
      return NextResponse.json(
        { error: "Integration not properly configured" },
        { status: 500 }
      );
    }
    const webhookSecret = resolved.secret;

    // WooCommerce sometimes sends an unsigned, form-encoded "ping"/validation request
    // (not an actual resource payload). Return 200 so Woo doesn't mark the delivery failed.
    if (
      platform === "WOOCOMMERCE" &&
      !webhookHeaders.signature &&
      request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/x-www-form-urlencoded")
    ) {
      if (process.env.WEBHOOK_DEBUG_HEADERS === "1") {
        console.error(`Ignoring unsigned WooCommerce form-encoded request for ${integrationId}`);
      }
      return NextResponse.json({ success: true, ignored: true });
    }

    // Optional: validate webhook source matches integration store URL (helps prevent misrouting)
    const sourceMismatch = isWebhookSourceMismatch(
      integration.storeUrl,
      webhookHeaders.source
    );
    if (sourceMismatch) {
      console.error(
        `Webhook source mismatch for ${integrationId}: expected ${sourceMismatch.expected}, received ${sourceMismatch.received}`
      );
      return NextResponse.json(
        { error: "Invalid webhook source" },
        { status: 401 }
      );
    }

    // Verify signature
    let verification = adapter.verifyWebhook(
      rawBodyBuffer,
      webhookHeaders,
      webhookSecret
    );

    // Shopify: help recover from common misconfiguration (secret stored in wrong field)
    if (!verification.isValid && platform === "SHOPIFY") {
      const fallbackAttempt = tryVerifyShopifyWithFallbackSecrets(
        adapter,
        rawBodyBuffer,
        webhookHeaders,
        integration,
        webhookSecret
      );
      if (fallbackAttempt?.verification.isValid) {
        verification = fallbackAttempt.verification;
        console.error(
          `Shopify webhook verified using fallback secret (${fallbackAttempt.source}) for ${integrationId}. Update the integration credentials to match.`
        );
      }
    }

    if (!verification.isValid) {
      console.error(
        `Webhook verification failed for ${integrationId}:`,
        verification.error
      );
      if (process.env.WEBHOOK_DEBUG_HEADERS === "1") {
        const headerNames = Array.from(request.headers.keys()).sort();
        const debug: Record<string, unknown> = {
          method: request.method,
          headerNames,
          contentType: request.headers.get("content-type"),
          userAgent: request.headers.get("user-agent"),
          secretSource: resolved.source,
        };

        if (platform === "SHOPIFY") {
          const receivedSig = webhookHeaders.signature?.trim() || "";
          const computedSig = createHmac("sha256", webhookSecret)
            .update(rawBodyBuffer)
            .digest("base64");
          debug.shopify = {
            shopDomain: webhookHeaders.source,
            topic: webhookHeaders.topic,
            apiVersion: webhookHeaders.apiVersion,
            isTest: request.headers.get("x-shopify-test") || undefined,
            contentLength: request.headers.get("content-length"),
            receivedSigPrefix: receivedSig.slice(0, 8),
            computedSigPrefix: computedSig.slice(0, 8),
            rawBodySha256: createHash("sha256").update(rawBodyBuffer).digest("hex"),
          };

          const tried = getShopifyCandidateSecretSources(integration, webhookSecret);
          debug.shopifyFallbackTried = tried;
        }

        console.error(`Webhook debug headers for ${integrationId}:`, {
          ...debug,
        });
      }

      // Optional: dump exact raw body for Shopify TEST deliveries to help diagnose HMAC mismatches.
      // Enable with WEBHOOK_DEBUG_BODY=1. This can include sensitive data; keep disabled in normal operation.
      if (
        process.env.WEBHOOK_DEBUG_BODY === "1" &&
        platform === "SHOPIFY" &&
        request.headers.get("x-shopify-test") === "true"
      ) {
        console.error(`Webhook debug body (base64) for ${integrationId}:`, rawBodyBuffer.toString("base64"));
      }
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 }
      );
    }

    // 3. Parse order using adapter.parseOrderWebhook()
    let normalizedOrder;
    try {
      normalizedOrder = adapter.parseOrderWebhook(rawBodyText);
    } catch (error) {
      console.error(`Failed to parse webhook for ${integrationId}:`, error);
      return NextResponse.json(
        { error: "Invalid webhook payload" },
        { status: 400 }
      );
    }

    // 4. Upsert ExternalOrder and ExternalOrderItem records
    // Use idempotency via unique constraint on [integrationId, externalId]
    const externalOrder = await prisma.externalOrder.upsert({
      where: {
        integrationId_externalId: {
          integrationId: integration.id,
          externalId: normalizedOrder.externalId,
        },
      },
      create: {
        companyId: integration.companyId,
        integrationId: integration.id,
        externalId: normalizedOrder.externalId,
        orderNumber: normalizedOrder.externalOrderNumber,
        nativeStatus: normalizedOrder.nativeStatus,
        financialStatus: normalizedOrder.financialStatus,
        fulfillmentStatus: normalizedOrder.fulfillmentStatus,
        total: normalizedOrder.total,
        currency: normalizedOrder.currency,
        customerEmail: normalizedOrder.customer?.email,
        customerName: normalizedOrder.customer?.name,
        rawPayload: normalizedOrder.rawPayload as Prisma.InputJsonValue,
        externalCreatedAt: normalizedOrder.createdAt,
      },
      update: {
        nativeStatus: normalizedOrder.nativeStatus,
        financialStatus: normalizedOrder.financialStatus,
        fulfillmentStatus: normalizedOrder.fulfillmentStatus,
        total: normalizedOrder.total,
        currency: normalizedOrder.currency,
        customerEmail: normalizedOrder.customer?.email,
        customerName: normalizedOrder.customer?.name,
        rawPayload: normalizedOrder.rawPayload as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
    });

    // 5. Try to auto-map items using existing ProductLink records
    for (const lineItem of normalizedOrder.lineItems) {
      // Look up existing ProductLink
      let productLink = null;
      if (lineItem.externalProductId) {
        productLink = await prisma.productLink.findFirst({
          where: {
            integrationId: integration.id,
            externalProductId: lineItem.externalProductId,
            externalVariantId: lineItem.externalVariantId ?? null,
          },
        });
      }

      // Upsert order item (find by orderId + externalItemId, then create or update)
      const existingItem = await prisma.externalOrderItem.findFirst({
        where: {
          orderId: externalOrder.id,
          externalItemId: lineItem.externalId,
        },
      });

      if (existingItem) {
        await prisma.externalOrderItem.update({
          where: { id: existingItem.id },
          data: {
            name: lineItem.name,
            sku: lineItem.sku,
            quantity: lineItem.quantity,
            price: lineItem.unitPrice,
            productLinkId: productLink?.id,
            isMapped: !!productLink,
          },
        });
      } else {
        await prisma.externalOrderItem.create({
          data: {
            orderId: externalOrder.id,
            externalItemId: lineItem.externalId,
            externalProductId: lineItem.externalProductId || "",
            externalVariantId: lineItem.externalVariantId,
            name: lineItem.name,
            sku: lineItem.sku,
            quantity: lineItem.quantity,
            price: lineItem.unitPrice,
            productLinkId: productLink?.id,
            isMapped: !!productLink,
          },
        });
      }
    }

    console.log(
      `Successfully processed webhook for integration ${integrationId}, order ${normalizedOrder.externalOrderNumber}`
    );

    // 6. Return 200 OK
    return NextResponse.json({
      success: true,
      orderId: externalOrder.id,
      orderNumber: normalizedOrder.externalOrderNumber,
    });
  } catch (error) {
    console.error(`Error processing webhook for ${integrationId}:`, error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

function resolveWebhookSecret(
  integration: {
    platform: string;
    webhookSecret: string | null;
    encryptedApiSecret: string | null;
  },
  platform: PlatformType
): { secret: string; source: string } | null {
  const tryDecryptOrPlain = (value: string | null): string | null => {
    if (!value) return null;
    if (!isEncrypted(value)) return value;
    try {
      return decryptValue(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to decrypt stored secret (check ENCRYPTION_KEY): ${message}`);
    }
  };

  // Shopify: webhook HMAC uses the app API secret key; prefer api secret to avoid misconfiguration.
  if (platform === "SHOPIFY") {
    const apiSecret = tryDecryptOrPlain(integration.encryptedApiSecret);
    if (apiSecret) return { secret: apiSecret.trim(), source: "integration.apiSecret" };
    const legacyWebhookSecret = tryDecryptOrPlain(integration.webhookSecret);
    if (legacyWebhookSecret) return { secret: legacyWebhookSecret.trim(), source: "integration.webhookSecret" };
    if (process.env.SHOPIFY_WEBHOOK_SECRET) return { secret: process.env.SHOPIFY_WEBHOOK_SECRET.trim(), source: "env.SHOPIFY_WEBHOOK_SECRET" };
  }

  // Prefer per-integration secret from DB
  const integrationSecret = tryDecryptOrPlain(integration.webhookSecret);
  if (integrationSecret) return { secret: integrationSecret, source: "integration.webhookSecret" };

  // WooCommerce: allow global env secret fallback if not stored per-integration
  if (platform === "WOOCOMMERCE") {
    if (process.env.WOOCOMMERCE_WEBHOOK_SECRET)
      return { secret: process.env.WOOCOMMERCE_WEBHOOK_SECRET, source: "env.WOOCOMMERCE_WEBHOOK_SECRET" };
  }

  return null;
}

function getShopifyCandidateSecretSources(
  integration: { webhookSecret: string | null; encryptedApiSecret: string | null },
  currentSecret: string
): string[] {
  const sources: string[] = [];
  const candidates: Array<{ value: string | null; source: string }> = [
    { value: integration.webhookSecret, source: "integration.webhookSecret" },
    { value: integration.encryptedApiSecret, source: "integration.apiSecret" },
    { value: process.env.SHOPIFY_WEBHOOK_SECRET ?? null, source: "env.SHOPIFY_WEBHOOK_SECRET" },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    let secret: string;
    try {
      secret = isEncrypted(candidate.value) ? decryptValue(candidate.value) : candidate.value;
    } catch {
      sources.push(`${candidate.source} (decrypt-failed)`);
      continue;
    }
    secret = secret.trim();
    if (!secret) continue;
    if (secret === currentSecret) continue;
    sources.push(candidate.source);
  }

  return sources;
}

function tryVerifyShopifyWithFallbackSecrets(
  adapter: { verifyWebhook: (rawBody: Buffer, headers: any, secret: string) => any },
  rawBodyBuffer: Buffer,
  webhookHeaders: any,
  integration: { webhookSecret: string | null; encryptedApiSecret: string | null },
  currentSecret: string
): { verification: any; source: string } | null {
  const candidates: Array<{ value: string | null; source: string }> = [
    { value: integration.webhookSecret, source: "integration.webhookSecret" },
    { value: integration.encryptedApiSecret, source: "integration.apiSecret" },
    { value: process.env.SHOPIFY_WEBHOOK_SECRET ?? null, source: "env.SHOPIFY_WEBHOOK_SECRET" },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    let secret: string;
    try {
      secret = isEncrypted(candidate.value) ? decryptValue(candidate.value) : candidate.value;
    } catch {
      continue;
    }
    secret = secret.trim();
    if (!secret) continue;
    if (secret === currentSecret) continue;

    const verification = adapter.verifyWebhook(rawBodyBuffer, webhookHeaders, secret);
    if (verification?.isValid) {
      return { verification, source: candidate.source };
    }
  }

  return null;
}

function isWebhookSourceMismatch(
  integrationStoreUrl: string,
  webhookSource: string | undefined
): { expected: string; received: string } | null {
  if (!webhookSource) return null;

  const expectedHost = safeHostFromUrl(integrationStoreUrl);
  if (!expectedHost) return null;

  // WooCommerce typically sends a full URL; Shopify sends a domain (no scheme).
  const receivedHostFromUrl = safeHostFromUrl(webhookSource);
  const receivedHost = receivedHostFromUrl || webhookSource.trim().toLowerCase();

  if (!receivedHost) return null;

  // If Shopify is configured with a custom domain in `storeUrl`, Shopify will still send
  // the *.myshopify.com domain in X-Shopify-Shop-Domain. Avoid hard-failing in that case.
  if (!receivedHostFromUrl && receivedHost.endsWith(".myshopify.com") && !expectedHost.endsWith(".myshopify.com")) {
    return null;
  }

  if (expectedHost !== receivedHost) {
    return { expected: expectedHost, received: receivedHost };
  }

  return null;
}

function safeHostFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}
