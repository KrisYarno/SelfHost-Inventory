import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import { decryptValue, isEncrypted } from "@/lib/encryption";
import { upsertOrderWithItems } from "@/lib/external-orders/shared";
import { recordIngestion } from "@/lib/change-tracking";
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
export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { integrationId: string } }
) => {
  const integrationId = params.integrationId;
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
      if (process.env.WEBHOOK_DEBUG_HEADERS === "1" && process.env.NODE_ENV !== "production") {
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
      // Phase 7c.3: record delivery failure for health display
      await recordWebhookFailure(integration.id, verification.error || "Unknown verification error");
      if (process.env.WEBHOOK_DEBUG_HEADERS === "1" && process.env.NODE_ENV !== "production") {
        const headerNames = Array.from(request.headers.keys()).sort();
        const secretLen = webhookSecret.length;
        const debug: Record<string, unknown> = {
          method: request.method,
          headerNames,
          contentType: request.headers.get("content-type"),
          userAgent: request.headers.get("user-agent"),
          secretSource: resolved.source,
          secretLen,
          secretSha256: createHash("sha256").update(webhookSecret, "utf8").digest("hex"),
        };

        if (platform === "SHOPIFY") {
          const receivedSig = webhookHeaders.signature?.trim() || "";
          const computedSig = createHmac("sha256", webhookSecret)
            .update(rawBodyBuffer)
            .digest("base64");
          const secretLooksLikeAccessToken = webhookSecret.startsWith("shpat_") || webhookSecret.startsWith("shpua_");
          debug.shopify = {
            shopDomain: webhookHeaders.source,
            topic: webhookHeaders.topic,
            apiVersion: webhookHeaders.apiVersion,
            isTest: request.headers.get("x-shopify-test") || undefined,
            contentLength: request.headers.get("content-length"),
            receivedSigPrefix: receivedSig.slice(0, 8),
            computedSigPrefix: computedSig.slice(0, 8),
            rawBodySha256: createHash("sha256").update(rawBodyBuffer).digest("hex"),
            secretLooksLikeAccessToken,
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
        process.env.NODE_ENV !== "production" &&
        platform === "SHOPIFY" &&
        request.headers.get("x-shopify-test") === "true"
      ) {
        const receivedSig = webhookHeaders.signature?.trim() || "";
        const computedSig = createHmac("sha256", webhookSecret)
          .update(rawBodyBuffer)
          .digest("base64");
        console.error(`Webhook debug signatures for ${integrationId}:`, {
          receivedSignature: receivedSig,
          computedSignature: computedSig,
        });
        console.error(`Webhook debug body (base64) for ${integrationId}:`, rawBodyBuffer.toString("base64"));
      }
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 }
      );
    }

    const topic = (webhookHeaders.topic || "").toLowerCase();

    // Ignore unsupported topics (avoid marking deliveries as failed when a store config includes non-order webhooks).
    // This endpoint is intentionally scoped to order-related topics only.
    if (!isOrderTopic(platform, topic)) {
      console.log(`Ignoring unsupported webhook topic for integration ${integrationId}: ${webhookHeaders.topic}`);
      return NextResponse.json({ success: true, ignored: true });
    }

    // -----------------------------------------------------------------------
    // S2 (codex #7/#8/#9): replay-dedup claim lifecycle. Taken AFTER the HMAC
    // check AND the unsupported-topic gate so ignored/unsigned deliveries never
    // strand a PROCESSING row. Dedup key = (integrationId, sha256(rawBody)) —
    // NEVER the unauthenticated eventId header. Any dedup-infra failure is
    // FAIL-OPEN (process without a claim) unless a duplicate was POSITIVELY
    // established. The claim token (id + claimedAt) fences finalization so no two
    // workers ever both process and a late loser can never overwrite the winner.
    const bodyDigest = createHash("sha256").update(rawBodyBuffer).digest("hex");
    const LEASE_MS = 5 * 60_000;
    const myClaimedAt = new Date();
    let claim: { id: number; claimedAt: Date } | null = null;
    try {
      claim = await prisma.webhookDelivery.create({
        data: {
          integrationId: integration.id,
          bodyDigest,
          eventId: webhookHeaders.eventId ?? null,
          claimedAt: myClaimedAt,
        },
        select: { id: true, claimedAt: true },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") {
        try {
          const existing = await prisma.webhookDelivery.findUnique({
            where: { integrationId_bodyDigest: { integrationId: integration.id, bodyDigest } },
            select: { id: true, status: true, claimedAt: true },
          });
          if (existing?.status === "PROCESSED") {
            return NextResponse.json({ ok: true, duplicate: true });
          }
          if (
            existing &&
            existing.status === "PROCESSING" &&
            Date.now() - existing.claimedAt.getTime() < LEASE_MS
          ) {
            // A live concurrent worker holds the lease.
            return NextResponse.json({ ok: true, duplicate: true });
          }
          if (existing) {
            // FAILED or stale PROCESSING: CONDITIONAL retake — only one concurrent
            // retaker wins (the where pins the row's current status + claimedAt).
            const won = await prisma.webhookDelivery.updateMany({
              where: { id: existing.id, status: existing.status, claimedAt: existing.claimedAt },
              data: { status: "PROCESSING", claimedAt: myClaimedAt },
            });
            if (won.count === 0) {
              return NextResponse.json({ ok: true, duplicate: true }); // lost the retake race
            }
            claim = { id: existing.id, claimedAt: myClaimedAt };
          }
          // existing === null (pruned/rolled-back winner): fall through with claim=null -> fail-open.
        } catch (inner) {
          console.error("[webhook] dedup lookup/retake failed — FAIL-OPEN", inner);
        }
      } else {
        console.error("[webhook] dedup claim failed — FAIL-OPEN", e);
      }
    }

    // Finalize the claim on a successful processing exit, fenced by the claim
    // token so a late stale worker cannot overwrite a retaker's row, then run a
    // bounded opportunistic prune. Best-effort — never fails the 200.
    const finalizeProcessed = async (): Promise<void> => {
      const c = claim;
      if (!c) return;
      try {
        await prisma.webhookDelivery.updateMany({
          where: { id: c.id, claimedAt: c.claimedAt },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
      } catch (err) {
        console.error("[webhook] failed to finalize PROCESSED", err);
      }
      await pruneOldDeliveries(c.id);
    };

    // Mark the claim FAILED (same fence) so a provider retry retakes and reprocesses.
    const finalizeFailed = async (): Promise<void> => {
      const c = claim;
      if (!c) return;
      try {
        await prisma.webhookDelivery.updateMany({
          where: { id: c.id, claimedAt: c.claimedAt },
          data: { status: "FAILED" },
        });
      } catch (err) {
        console.error("[webhook] failed to finalize FAILED", err);
      }
    };

    try {
      // 3a. Handle delete events (payload may not match full order schema)
      if (isDeleteWebhookEvent(platform, topic)) {
        const externalId = extractExternalOrderId(rawBodyText);
        if (!externalId) {
          console.error(`Delete webhook missing order id for ${integrationId}`);
          await finalizeProcessed();
          return NextResponse.json({ success: true, ignored: true });
        }

        // Phase 7c: protect fulfilled orders from silent deletion.
        // If any item on the order has been fulfilled locally (fulfilledQty > 0
        // OR internalStatus is 'fulfilled'), refuse to delete and keep the audit
        // trail intact. The inventory was already deducted — we need the order
        // row to explain why. The WC side is now divergent; the operator must
        // decide whether to unfulfill + delete manually, or accept divergence.
        const deleteResult = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          // R-D11: capture the FULL order + items snapshot inside the tx BEFORE
          // deleting — destroyed state is otherwise unrecoverable.
          const existing = await tx.externalOrder.findUnique({
            where: {
              integrationId_externalId: {
                integrationId: integration.id,
                externalId,
              },
            },
            include: { items: true },
          });

          if (!existing) {
            return { action: "not_found" as const };
          }

          // stockedOut separation: one clean boolean check replaces the old
          // fulfilledQty-arithmetic + internalStatus dual check.
          if (existing.stockedOut) {
            // Protected — keep the order, keep its items, keep the audit trail.
            return {
              action: "protected" as const,
              orderNumber: existing.orderNumber,
            };
          }

          // Safe to delete — no fulfillment work to preserve
          await tx.externalOrderItem.deleteMany({ where: { orderId: existing.id } });
          await tx.externalOrder.delete({ where: { id: existing.id } });
          return {
            action: "deleted" as const,
            orderId: existing.id,
            orderNumber: existing.orderNumber,
            snapshot: existing,
          };
        });

        // Phase 7c.3: all three delete outcomes count as successful webhook
        // deliveries (signature passed, we processed the event). Record health.
        // ER-B3 ORDER: recordWebhookSuccess FIRST, THEN the ingestion record —
        // so an audit-write failure (recorded by onFailure) is never wiped by the
        // success reset.
        await recordWebhookSuccess(integration.id);

        if (deleteResult.action === "not_found") {
          // Idempotent: if we never had the order, delete is a no-op — records
          // NOTHING (no state change).
          await finalizeProcessed();
          return NextResponse.json({ success: true, ignored: true });
        }

        if (deleteResult.action === "protected") {
          console.warn(
            `[webhook] REFUSED delete for fulfilled order ${deleteResult.orderNumber} (integration ${integrationId}, externalId ${externalId}). Order retained for audit trail; operator must reconcile manually.`
          );
          await finalizeProcessed();
          return NextResponse.json({
            success: true,
            protected: true,
            reason: "Order has fulfillment work; audit trail preserved",
          });
        }

        console.log(
          `Deleted external order ${deleteResult.orderNumber} for integration ${integrationId}, externalId ${externalId}`
        );

        // R-D4/R-D11: record the delete as an ingestion event with the full
        // pre-delete snapshot. Best-effort — a record failure bumps the webhook
        // health counter but never fails the 200 (the row is already gone).
        await recordIngestion(
          {
            actor: {
              kind: "WEBHOOK",
              envelope: { integrationId: integration.id, topic },
            },
            actionType: "EXTERNAL_ORDER_DELETE",
            entityType: "ORDER",
            entityId: deleteResult.orderId,
            companyId: integration.companyId,
            action: `Webhook deleted order ${deleteResult.orderNumber}`,
            details: { platform, snapshot: deleteResult.snapshot },
          },
          {
            onFailure: () =>
              recordWebhookFailure(integration.id, "change-tracking write failed"),
          }
        );

        await finalizeProcessed();
        return NextResponse.json({ success: true, deleted: true });
      }

      // 3. Parse order using adapter.parseOrderWebhook()
      let normalizedOrder;
      try {
        normalizedOrder = adapter.parseOrderWebhook(rawBodyText);
      } catch (error) {
        console.error(`Failed to parse webhook for ${integrationId}:`, error);
        // Malformed payload: mark FAILED (not stranded PROCESSING) and answer 400.
        await finalizeFailed();
        return NextResponse.json(
          { error: "Invalid webhook payload" },
          { status: 400 }
        );
      }

      // 4. Upsert ExternalOrder and ExternalOrderItem records (atomic transaction)
      const summary = await upsertOrderWithItems(prisma, {
        integrationId: integration.id,
        companyId: integration.companyId,
        storeUrl: integration.storeUrl,
        normalized: normalizedOrder,
        status: { statusMode: "compute", platform },
      });

      console.log(
        `Successfully processed webhook for integration ${integrationId}, order ${normalizedOrder.externalOrderNumber}`
      );

      // Update lastSyncAt so the incremental poller can catch up from outages,
      // and record webhook health for operator visibility.
      // ER-B3 ORDER: recordWebhookSuccess (resets webhookFailureCount) FIRST,
      // THEN the R-D4 ingestion record — so an audit-write failure signalled by
      // onFailure survives instead of being wiped by the success reset.
      await recordWebhookSuccess(integration.id);

      // 5. R-D4: record ONLY an effective transition (gate on summary.changed).
      // An unchanged re-delivery writes no event. Best-effort — a record failure
      // bumps webhook health but never fails the 200 (the upsert already
      // committed).
      if (summary.changed) {
        await recordIngestion(
          {
            actor: {
              kind: "WEBHOOK",
              envelope: { integrationId: integration.id, topic },
            },
            actionType: summary.created
              ? "EXTERNAL_ORDER_CREATE"
              : "EXTERNAL_ORDER_UPDATE",
            entityType: "ORDER",
            entityId: summary.orderId,
            companyId: integration.companyId,
            action: `Webhook ${summary.created ? "created" : "updated"} order ${summary.orderNumber ?? summary.orderId}`,
            changes: summary.changes,
            details: { platform, prunedItems: summary.prunedItems },
          },
          {
            onFailure: () =>
              recordWebhookFailure(integration.id, "change-tracking write failed"),
          }
        );
      }

      // 6. S2: finalize the claim PROCESSED, then return 200 OK.
      await finalizeProcessed();
      return NextResponse.json({
        success: true,
        orderId: summary.orderId,
        orderNumber: normalizedOrder.externalOrderNumber,
      });
    } catch (err) {
      // Any processing throw: mark the claim FAILED (best-effort) and rethrow so
      // apiHandler answers non-2xx and the provider retries + reprocesses.
      await finalizeFailed();
      throw err;
    }
});

/**
 * Resolve the webhook SIGNING secret.
 *
 * LANE 6 / REV-2 #11 — THE LANDMINE, DEFUSED. This function used to fall back to
 * `integration.encryptedApiSecret` for Shopify. Lane 6 renames that column to
 * `encryptedWriteSecret` (the write-capable API credential). Had the fallback
 * survived the rename, the STORE-WRITE SECRET would have silently become the
 * webhook-signing secret — conflating the two most sensitive values in the system
 * and making the credential split meaningless.
 *
 * The API-credential fallback is REMOVED. A dedicated `webhookSecret` (or the
 * platform's env secret) is now REQUIRED. If neither is present we fail closed:
 * no secret, no verification, no ingestion — and a health warning names the
 * integration. That is strictly correct anyway: a webhook-signing secret and an
 * API credential are different secrets with different lifecycles, and Shopify's
 * own docs treat them as such.
 */
function resolveWebhookSecret(
  integration: {
    platform: string;
    webhookSecret: string | null;
  },
  platform: PlatformType
): { secret: string; source: string } | null {
  const normalizeSecret = (value: string): string => {
    let s = value.trim();
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      s = s.slice(1, -1).trim();
    }
    return s;
  };

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

  // Prefer the per-integration dedicated signing secret, on BOTH platforms.
  const integrationSecret = tryDecryptOrPlain(integration.webhookSecret);
  if (integrationSecret)
    return { secret: normalizeSecret(integrationSecret), source: "integration.webhookSecret" };

  // Platform-scoped env fallback. Still a DEDICATED signing secret — never an API credential.
  if (platform === "SHOPIFY" && process.env.SHOPIFY_WEBHOOK_SECRET) {
    return {
      secret: normalizeSecret(process.env.SHOPIFY_WEBHOOK_SECRET),
      source: "env.SHOPIFY_WEBHOOK_SECRET",
    };
  }
  if (platform === "WOOCOMMERCE" && process.env.WOOCOMMERCE_WEBHOOK_SECRET) {
    return {
      secret: normalizeSecret(process.env.WOOCOMMERCE_WEBHOOK_SECRET),
      source: "env.WOOCOMMERCE_WEBHOOK_SECRET",
    };
  }

  // Fail closed. No API-credential fallback (REV-2 #11).
  console.error(
    `[webhook] No dedicated webhook signing secret for integration ${integration.platform}. ` +
      `Set integration.webhookSecret (or the platform env secret). ` +
      `The API credential is NOT a valid signing secret and is no longer used as one.`
  );
  return null;
}

/**
 * REV-2 #11: the `integration.apiSecret` candidate is REMOVED. Only dedicated
 * signing secrets are ever tried — the write-capable API credential is not one.
 */
function getShopifyCandidateSecretSources(
  integration: { webhookSecret: string | null },
  currentSecret: string
): string[] {
  const sources: string[] = [];
  const candidates: Array<{ value: string | null; source: string }> = [
    { value: integration.webhookSecret, source: "integration.webhookSecret" },
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

/**
 * REV-2 #11: the `integration.apiSecret` candidate is REMOVED here too. Verifying
 * a webhook against the store-WRITE credential is exactly the conflation the
 * credential split exists to prevent.
 */
function tryVerifyShopifyWithFallbackSecrets(
  adapter: { verifyWebhook: (rawBody: Buffer, headers: any, secret: string) => any },
  rawBodyBuffer: Buffer,
  webhookHeaders: any,
  integration: { webhookSecret: string | null },
  currentSecret: string
): { verification: any; source: string } | null {
  const candidates: Array<{ value: string | null; source: string }> = [
    { value: integration.webhookSecret, source: "integration.webhookSecret" },
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

function isOrderTopic(platform: PlatformType, topic: string): boolean {
  const t = (topic || "").toLowerCase();
  if (!t) return true; // if topic is missing, attempt to parse as order payload (legacy / test)
  if (platform === "SHOPIFY") return t.startsWith("orders/");
  if (platform === "WOOCOMMERCE") return t.startsWith("order.");
  return true;
}

function isDeleteWebhookEvent(platform: PlatformType, topic: string): boolean {
  const t = topic.toLowerCase();
  if (!t) return false;
  if (platform === "SHOPIFY") return t === "orders/delete" || t.endsWith("/delete");
  if (platform === "WOOCOMMERCE") return t === "order.deleted" || t.endsWith(".order.deleted") || t.includes("order.deleted");
  return false;
}

function extractExternalOrderId(rawBodyText: string): string | null {
  try {
    const parsed = JSON.parse(rawBodyText) as any;
    const id =
      parsed?.id ??
      parsed?.order_id ??
      parsed?.orderId ??
      parsed?.data?.id ??
      null;
    if (id === null || id === undefined) return null;
    return String(id);
  } catch {
    return null;
  }
}

/**
 * S2 (codex #9): bounded opportunistic prune of the replay-dedup ledger. Runs
 * only ~1% of the time (when the winning claim's id is a multiple of 100), so no
 * new scheduler is needed. Deletes at most 500 rows older than the 30-day window,
 * AWAITED with its own try/catch so it never surfaces an unhandled rejection or
 * fails the webhook.
 */
async function pruneOldDeliveries(claimId: number): Promise<void> {
  if (claimId % 100 !== 0) return;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const stale = await prisma.webhookDelivery.findMany({
      where: { receivedAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });
    if (stale.length > 0) {
      await prisma.webhookDelivery.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
    }
  } catch (err) {
    console.error("[webhook] delivery prune failed", err);
  }
}

// ---------------------------------------------------------------------------
// Phase 7c.3: Webhook delivery health tracking
// ---------------------------------------------------------------------------

/**
 * Record a successful webhook delivery on the integration. Also bumps
 * lastSyncAt so the incremental poller can catch up from outages.
 */
async function recordWebhookSuccess(integrationId: string): Promise<void> {
  try {
    const now = new Date();
    await prisma.integration.update({
      where: { id: integrationId },
      data: {
        lastSyncAt: now,
        lastWebhookReceivedAt: now,
        lastWebhookError: null,
        webhookFailureCount: 0,
      },
    });
  } catch (err) {
    // Never fail the webhook over telemetry — log and continue.
    console.error(`[webhook health] Failed to record success for ${integrationId}:`, err);
  }
}

/**
 * Record a webhook failure (signature mismatch, parse error, etc.). Bumps the
 * failure counter and stores the most recent error message for the admin UI.
 */
async function recordWebhookFailure(
  integrationId: string,
  errorMessage: string
): Promise<void> {
  try {
    await prisma.integration.update({
      where: { id: integrationId },
      data: {
        lastWebhookError: errorMessage.slice(0, 500),
        webhookFailureCount: { increment: 1 },
      },
    });
  } catch (err) {
    console.error(`[webhook health] Failed to record failure for ${integrationId}:`, err);
  }
}

