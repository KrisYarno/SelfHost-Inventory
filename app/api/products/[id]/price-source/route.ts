import { NextRequest, NextResponse } from "next/server";
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
  requireCSRF,
} from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { fetchExternalProductPrice } from "@/lib/external-orders/price-sync";
import { PriceSourceSchema } from "@/lib/validation/product";

export const dynamic = "force-dynamic";

/**
 * POST /api/products/[id]/price-source
 *
 * Set or clear the price source for a product.
 * Body: { linkId: string | null, syncNow?: boolean }
 *
 * - linkId = null → clear priceSourceLinkId (revert to manual pricing)
 * - linkId = <id> → set priceSourceLinkId, optionally sync price immediately
 */
export const POST = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: { id: string } }
  ) => {
    const { user } = await requireAdmin();

    await requireCSRF(request);

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json(
        { error: "Invalid product ID" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const parsed = PriceSourceSchema.parse(body);
    const linkId: string | null = parsed.linkId ?? null;
    const syncNow: boolean = parsed.syncNow === true;

    // Verify product exists
    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
    });

    if (!product) {
      return NextResponse.json(
        { error: "Product not found" },
        { status: 404 }
      );
    }

    // Clear source
    if (linkId === null) {
      // BUG FIX (plan step 5): was actionType "ProductUpdate" as any with the
      // transition buried in details.previousLinkId. Now a real PRODUCT_UPDATE
      // with a first-class {priceSourceLinkId:{from,to}} diff, recorded in the
      // SAME tx as the update.
      await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: productId },
          data: { priceSourceLinkId: null },
        });

        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: "PRODUCT_UPDATE",
          entityType: "PRODUCT",
          entityId: productId,
          action: `Cleared price source for ${product.name}`,
          changes: { priceSourceLinkId: { from: product.priceSourceLinkId, to: null } },
          details: { productId },
          affectedCount: 1,
        });
      });

      return NextResponse.json({
        success: true,
        priceSourceLinkId: null,
        // W0-RETAIL: Number(null)=0 would report a phantom $0 for an unknown price.
        retailPrice: product.retailPrice === null ? null : Number(product.retailPrice),
      });
    }

    // Validate the link exists and belongs to this product
    const link = await prisma.productLink.findUnique({
      where: { id: linkId },
      include: {
        integration: { select: { id: true, companyId: true, name: true, platform: true } },
      },
    });

    if (!link) {
      return NextResponse.json(
        { error: "Product link not found" },
        { status: 404 }
      );
    }

    if (link.internalProductId !== productId) {
      return NextResponse.json(
        { error: "This link does not belong to this product" },
        { status: 400 }
      );
    }

    // Company membership check
    await requireCompanyMembership(
      user.id,
      link.integration.companyId,
      user.isAdmin
    );

    // W0-RETAIL: null when the retail is unknown (Number(null)=0 would lie a $0 to
    // the client at line ~180); a successful sync below replaces it with a real price.
    let newRetailPrice: number | null =
      product.retailPrice === null ? null : Number(product.retailPrice);
    let syncError: string | undefined;
    let fetchedPrice: number | null = null;

    // Optionally sync the price immediately. The external fetch is a network call
    // and MUST stay OUTSIDE the transaction (spec D4) — it depends only on the
    // link's integration/external ids, not on priceSourceLinkId being set yet, so
    // pulling it ahead of the writes is behavior-equivalent.
    if (syncNow) {
      const { regularPrice, error } = await fetchExternalProductPrice(
        link.integration.id,
        link.externalProductId,
        link.externalVariantId
      );

      if (regularPrice !== null) {
        fetchedPrice = regularPrice;
        newRetailPrice = regularPrice;
      } else {
        syncError = error;
      }
    }

    // Set the price source (+ synced retail price) and record atomically.
    // BUG FIX (plan step 5): real PRODUCT_UPDATE with a first-class
    // {priceSourceLinkId:{from,to}} diff instead of "ProductUpdate" as any.
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { priceSourceLinkId: linkId },
      });

      if (fetchedPrice !== null) {
        await tx.product.update({
          where: { id: productId },
          data: { retailPrice: fetchedPrice },
        });
      }

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "PRODUCT_UPDATE",
        entityType: "PRODUCT",
        entityId: productId,
        action: `Set price source for ${product.name} to ${link.integration.name} (${link.externalTitle || link.externalProductId})`,
        changes: { priceSourceLinkId: { from: product.priceSourceLinkId, to: linkId } },
        details: {
          productId,
          linkId,
          integrationName: link.integration.name,
          externalTitle: link.externalTitle,
          syncNow,
          newRetailPrice,
          syncError,
        },
        affectedCount: 1,
      });
    });

    return NextResponse.json({
      success: true,
      priceSourceLinkId: linkId,
      retailPrice: newRetailPrice,
      source: {
        integrationName: link.integration.name,
        externalTitle: link.externalTitle,
        externalProductId: link.externalProductId,
        externalVariantId: link.externalVariantId,
      },
      syncError,
    });
  }
);
