import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const filter = searchParams.get("filter"); // 'all', 'approved', 'pending'
    const search = searchParams.get("search");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const skip = (page - 1) * limit;

    // Build where clause - always exclude soft-deleted users
    const where: any = {
      deletedAt: null,
    };

    if (filter === "approved") {
      where.isApproved = true;
    } else if (filter === "pending") {
      where.isApproved = false;
    }

    if (search) {
      where.OR = [{ email: { contains: search } }, { username: { contains: search } }];
    }

    // Check if detailed user info is requested (for edit dialog)
    const includeDetails = searchParams.get("include") === "details";

    // Get users and count
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          isAdmin: true,
          isApproved: true,
          ...(includeDetails && {
            defaultLocationId: true,
            emailAlerts: true,
            phoneNumber: true,
            minLocationEmailAlerts: true,
            minLocationSmsAlerts: true,
            minCombinedEmailAlerts: true,
            minCombinedSmsAlerts: true,
            companies: {
              select: {
                companyId: true,
              },
            },
          }),
        },
        orderBy: { id: "desc" },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    let transformedUsers: any = users;
    if (includeDetails) {
      const allCompanyIds = Array.from(
        new Set(
          (users as any[])
            .flatMap((u) => (u.companies || []).map((c: any) => c.companyId))
            .filter(Boolean)
        )
      );
      const companies = allCompanyIds.length
        ? await prisma.company.findMany({
            where: { id: { in: allCompanyIds } },
            select: { id: true, name: true },
          })
        : [];
      const companyNameById = new Map(companies.map((c) => [c.id, c.name]));

      transformedUsers = (users as any[]).map((user) => ({
        ...user,
        companies: (user.companies || []).map((c: any) => ({
          companyId: c.companyId,
          companyName: companyNameById.get(c.companyId) ?? "(deleted company)",
        })),
      }));
    }

    return NextResponse.json({
      users: transformedUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
