import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireCompanyMembership, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const searchParams = request.nextUrl.searchParams;
  const integrationId = searchParams.get("integrationId");
  const search = searchParams.get("search");
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");
  const skip = (page - 1) * pageSize;

  // Build where clause
  const where: any = {};

  if (integrationId) {
    // P0-4: if a specific integration is requested, verify the user belongs
    // to its company (admins bypass via requireCompanyMembership).
    const integration = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: { companyId: true },
    });
    if (!integration) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }
    await requireCompanyMembership(user.id, integration.companyId, user.isAdmin);
    where.integrationId = integrationId;
  } else if (!user.isAdmin) {
    // P0-4: without a specific integration filter, scope to the user's companies
    // via the integration relation. Platform admins see everything.
    const userCompanies = await prisma.userCompany.findMany({
      where: { userId: user.id },
      select: { companyId: true },
    });
    where.integration = {
      companyId: { in: userCompanies.map((uc) => uc.companyId) },
    };
  }

  if (search) {
    where.OR = [
      { externalTitle: { contains: search } },
      { externalSku: { contains: search } },
      { internalProduct: { name: { contains: search } } },
    ];
  }

  const [productLinks, total] = await Promise.all([
    prisma.productLink.findMany({
      where,
      include: {
        internalProduct: {
          select: {
            id: true,
            name: true,
            baseName: true,
            variant: true,
            priceSourceLinkId: true,
            retailPrice: true,
          },
        },
        integration: {
          select: {
            id: true,
            name: true,
            platform: true,
            storeUrl: true,
          },
        },
        bundleComponents: {
          include: { internalProduct: { select: { id: true, name: true } } },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: [{ integration: { name: "asc" } }, { createdAt: "desc" }],
      skip,
      take: pageSize,
    }),
    prisma.productLink.count({ where }),
  ]);

  // P2: bundleComponents is always [] for single mappings (isBundle=false).
  // Project it (and componentCount) to undefined for non-bundle rows so the
  // payload is consistent and consumers don't have to walk the array just to
  // know the length.
  const mappings = productLinks.map((m: any) => ({
    ...m,
    bundleComponents: m.isBundle ? m.bundleComponents : undefined,
    componentCount: m.isBundle ? m.bundleComponents.length : undefined,
  }));

  return NextResponse.json({
    mappings,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const { searchParams } = new URL(request.url);
  const linkId = searchParams.get("linkId");

  if (!linkId) {
    return NextResponse.json(
      { error: "Link ID is required" },
      { status: 400 }
    );
  }

  const existingLink = await prisma.productLink.findUnique({
    where: { id: linkId },
    include: {
      integration: { select: { companyId: true } },
    },
  });

  if (!existingLink) {
    return NextResponse.json(
      { error: "Product link not found" },
      { status: 404 }
    );
  }

  // P0-4: Verify user belongs to the link's integration's company.
  await requireCompanyMembership(
    user.id,
    existingLink.integration.companyId,
    user.isAdmin
  );

  // Full redacted link-row snapshot (R-D11) — strip the joined integration
  // relation so `snapshot` is the link row itself, not its parent.
  const { integration, ...linkRow } = existingLink;

  // Delete the product link. With onDelete: SetNull, the FK on ExternalOrderItem
  // will be nulled automatically by the database. But we also need to set isMapped = false.
  await prisma.$transaction(async (tx) => {
    // R-D11 cascade identity: read the bundle components BEFORE the link (and its
    // Cascade-deleted components) vanish. Cap 1000.
    const bundleComponents = await tx.bundleComponent.findMany({
      where: { productLinkId: linkId },
      select: { id: true, internalProductId: true, quantity: true },
      take: 1000,
    });

    // Set isMapped = false on affected order items
    const unmapped = await tx.externalOrderItem.updateMany({
      where: { productLinkId: linkId },
      data: { isMapped: false },
    });

    // Delete the product link
    await tx.productLink.delete({
      where: { id: linkId },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "MAPPING_DELETE",
      entityType: "MAPPING",
      entityId: linkId,
      companyId: integration.companyId,
      action: `Deleted product mapping ${linkId}`,
      details: {
        snapshot: linkRow,
        cascade: {
          bundleComponents,
          unmappedOrderItems: unmapped.count,
        },
      },
    });
  });

  return NextResponse.json({
    message: "Product mapping deleted successfully",
  });
});
