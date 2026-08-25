import { redirect } from "next/navigation";
import { requireAdmin, requireCompanyMembership } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { MassMapClient } from "@/components/products/mass-map/mass-map-client";

export const dynamic = "force-dynamic";

/**
 * The reconciliation lane's unmapped tab deep-links here with the exact
 * external product a person was sent to map (pack C4b.2). The three params are
 * read here and handed down as ONE prop: `externalProductId` is what identifies
 * the row, so no id means no pre-fill at all — an empty variant or sku is a
 * real value (a simple product with no sku), not a missing link.
 */
export default async function BulkMapPage({
  params,
  searchParams,
}: {
  params: { integrationId: string };
  searchParams?: { externalProductId?: string; externalVariantId?: string; sku?: string };
}) {
  const { user } = await requireAdmin();

  const integration = await prisma.integration.findUnique({
    where: { id: params.integrationId },
    select: { id: true, companyId: true },
  });

  if (!integration) {
    redirect("/admin/product-mappings");
  }

  await requireCompanyMembership(user.id, integration.companyId, user.isAdmin);

  const externalProductId = searchParams?.externalProductId;
  const prefill = externalProductId
    ? {
        externalProductId,
        externalVariantId: searchParams?.externalVariantId || null,
        sku: searchParams?.sku || null,
      }
    : undefined;

  return <MassMapClient integrationId={params.integrationId} prefill={prefill} />;
}
