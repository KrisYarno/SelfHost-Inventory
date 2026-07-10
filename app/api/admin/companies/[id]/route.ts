import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange, diff } from "@/lib/change-tracking";
import { CompanyInputSchema } from "@/lib/validation/companies";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/companies/[id]
 * Get single company (admin only)
 */
export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  await requireAdmin();

  const company = await prisma.company.findUnique({
    where: { id: params.id },
    include: {
      _count: {
        select: {
          users: true,
          integrations: true,
          orders: true,
        },
      },
    },
  });

  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  return NextResponse.json({ company });
});

/**
 * PUT /api/admin/companies/[id]
 * Update company
 */
export const PUT = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  const { name, slug } = CompanyInputSchema.parse(body);

  // Check if slug is being changed and if it conflicts
  const existing = await prisma.company.findUnique({
    where: { slug },
  });

  if (existing && existing.id !== params.id) {
    return NextResponse.json(
      { error: "A company with this slug already exists" },
      { status: 409 }
    );
  }

  // Fetch the before-image BY ID (today only the slug-collision row is read),
  // update, and record the diff in ONE tx. Empty diff => no event (ER-B9).
  const company = await prisma.$transaction(async (tx) => {
    const before = await tx.company.findUniqueOrThrow({
      where: { id: params.id },
      select: { name: true, slug: true },
    });

    const updated = await tx.company.update({
      where: { id: params.id },
      data: { name, slug },
    });

    const changes = diff(before, { name, slug }, ["name", "slug"]);
    if (Object.keys(changes).length > 0) {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "COMPANY_UPDATE",
        entityType: "COMPANY",
        entityId: params.id,
        companyId: params.id,
        action: `Updated company "${before.name}"`,
        changes,
      });
    }

    return updated;
  });

  return NextResponse.json({ company });
});

/**
 * DELETE /api/admin/companies/[id]
 * Delete company (and all associated data via cascade)
 */
export const DELETE = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  // Check if company exists and whether it is safe to delete
  const company = await prisma.company.findUnique({
    where: { id: params.id },
    include: {
      _count: {
        select: {
          users: true,
          integrations: true,
          orders: true,
        },
      },
    },
  });

  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  // Prevent accidental deletion that would orphan users/data. Guard unchanged
  // (P-B6 rev.): salesFacts cascade with their integration and the guard already
  // requires zero integrations, so no salesFacts count/deleteMany is needed. The
  // 409 body names each nonzero blocker so the admin knows what to reassign.
  const { _count, ...companyRow } = company;
  const blockers: string[] = [];
  if (_count.users > 0) blockers.push(`${_count.users} users`);
  if (_count.integrations > 0) blockers.push(`${_count.integrations} integrations`);
  if (_count.orders > 0) blockers.push(`${_count.orders} orders`);
  if (blockers.length > 0) {
    return NextResponse.json(
      {
        error: `Company "${company.name}" cannot be deleted: it still has ${blockers.join(
          ", "
        )}. Reassign or delete those first before deleting the company.`,
      },
      { status: 409 }
    );
  }

  // Delete + record the R-D11 snapshot in ONE tx. salesFacts cascade via the DB.
  await prisma.$transaction(async (tx) => {
    await tx.company.delete({ where: { id: params.id } });
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "COMPANY_DELETE",
      entityType: "COMPANY",
      entityId: params.id,
      companyId: params.id,
      action: `Deleted company "${company.name}"`,
      details: { snapshot: companyRow },
    });
  });

  return NextResponse.json({
    success: true,
    message: "Company deleted successfully",
  });
});
