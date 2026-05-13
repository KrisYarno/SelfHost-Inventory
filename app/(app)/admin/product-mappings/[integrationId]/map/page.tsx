import { redirect } from "next/navigation";
import { requireAdmin, requireCompanyMembership } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { MassMapClient } from "@/components/products/mass-map/mass-map-client";

export const dynamic = "force-dynamic";

export default async function BulkMapPage({
  params,
}: {
  params: { integrationId: string };
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

  return <MassMapClient integrationId={params.integrationId} />;
}
