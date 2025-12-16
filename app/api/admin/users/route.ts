import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
                company: {
                  select: {
                    name: true,
                  },
                },
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

    // Transform the users to flatten company data if details were included
    const transformedUsers = includeDetails
      ? users.map((user: any) => ({
          ...user,
          companies: user.companies?.map((c: any) => ({
            companyId: c.companyId,
            companyName: c.company?.name,
          })),
        }))
      : users;

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
