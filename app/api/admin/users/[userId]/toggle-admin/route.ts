import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";
import { z } from "zod";

const ToggleAdminSchema = z.object({
  isAdmin: z.boolean(),
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: { userId: string } }) {
  try {
    const { user: adminUser } = await requireAdmin();

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const userId = parseInt(params.userId);
    if (isNaN(userId) || userId === 0) {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }

    const body = await request.json();
    const parsed = ToggleAdminSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { isAdmin } = parsed.data;

    // Prevent admins from removing their own admin status
    if (userId === adminUser.id && !isAdmin) {
      return NextResponse.json(
        { error: "Cannot remove your own admin privileges" },
        { status: 400 }
      );
    }

    // Update user admin status
    const user = await prisma.user.update({
      where: { id: userId },
      data: { isAdmin },
    });

    return NextResponse.json({
      message: "User role updated successfully",
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        isAdmin: user.isAdmin,
      },
    });
  } catch (error) {
    console.error("Error updating user role:", error);
    return NextResponse.json({ error: "Failed to update user role" }, { status: 500 });
  }
}
