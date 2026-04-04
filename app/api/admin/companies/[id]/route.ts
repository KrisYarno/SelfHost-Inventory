import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

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
  await requireAdmin();

  const body = await request.json();
  const { name, slug } = body;

  // Validate input
  if (!name || !slug) {
    return NextResponse.json(
      { error: "Name and slug are required" },
      { status: 400 }
    );
  }

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json(
      { error: "Slug must contain only lowercase letters, numbers, and hyphens" },
      { status: 400 }
    );
  }

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

  // Update company
  const company = await prisma.company.update({
    where: { id: params.id },
    data: {
      name,
      slug,
    },
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
  await requireAdmin();

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

  // Prevent accidental deletion that would orphan users/data.
  if (company._count.users > 0 || company._count.integrations > 0 || company._count.orders > 0) {
    return NextResponse.json(
      {
        error:
          "Company has associated users/integrations/orders. Reassign or delete those first before deleting the company.",
      },
      { status: 409 }
    );
  }

  await prisma.company.delete({ where: { id: params.id } });

  return NextResponse.json({
    success: true,
    message: "Company deleted successfully",
  });
});
