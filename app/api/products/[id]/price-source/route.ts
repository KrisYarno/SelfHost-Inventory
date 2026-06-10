import { NextRequest, NextResponse } from "next/server";
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
  requireCSRF,
} from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";
import { fetchExternalProductPrice } from "@/lib/external-orders/price-sync";

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
    const linkId: string | null = body.linkId ?? null;
    const syncNow: boolean = body.syncNow === true;

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
      await prisma.product.update({
        where: { id: productId },
        data: { priceSourceLinkId: null },
      });

      await auditService.log({
        userId: user.id,
        actionType: "ProductUpdate" as any,
        entityType: "PRODUCT",
        action: `Cleared price source for ${product.name}`,
        details: { productId, previousLinkId: product.priceSourceLinkId },
        affectedCount: 1,
      });

      return NextResponse.json({
        success: true,
        priceSourceLinkId: null,
        retailPrice: Number(product.retailPrice),
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

    // Set the price source
    await prisma.product.update({
      where: { id: productId },
      data: { priceSourceLinkId: linkId },
    });

    let newRetailPrice = Number(product.retailPrice);
    let syncError: string | undefined;

    // Optionally sync the price immediately
    if (syncNow) {
      const { regularPrice, error } = await fetchExternalProductPrice(
        link.integration.id,
        link.externalProductId,
        link.externalVariantId
      );

      if (regularPrice !== null) {
        await prisma.product.update({
          where: { id: productId },
          data: { retailPrice: regularPrice },
        });
        newRetailPrice = regularPrice;
      } else {
        syncError = error;
      }
    }

    await auditService.log({
      userId: user.id,
      actionType: "ProductUpdate" as any,
      entityType: "PRODUCT",
      action: `Set price source for ${product.name} to ${link.integration.name} (${link.externalTitle || link.externalProductId})`,
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
