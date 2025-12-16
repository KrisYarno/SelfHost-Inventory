import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/companies/[id]
 * Get single company (admin only)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
  } catch (error) {
    console.error("Error fetching company:", error);
    return NextResponse.json(
      { error: "Failed to fetch company" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/companies/[id]
 * Update company
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
  } catch (error) {
    console.error("Error updating company:", error);
    return NextResponse.json(
      { error: "Failed to update company" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/companies/[id]
 * Delete company (and all associated data via cascade)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if company exists
    const company = await prisma.company.findUnique({
      where: { id: params.id },
      include: {
        _count: {
          select: {
            integrations: true,
            orders: true,
          },
        },
      },
    });

    if (!company) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    // Delete company (cascade will delete integrations, orders, etc.)
    await prisma.company.delete({
      where: { id: params.id },
    });

    return NextResponse.json({
      success: true,
      message: "Company deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting company:", error);
    return NextResponse.json(
      { error: "Failed to delete company" },
      { status: 500 }
    );
  }
}
