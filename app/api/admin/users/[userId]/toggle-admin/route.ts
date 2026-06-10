import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { z } from "zod";

const ToggleAdminSchema = z.object({
  isAdmin: z.boolean(),
});

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest, { params }: { params: { userId: string } }) => {
  const { user: adminUser } = await requireAdmin();

  await requireCSRF(request);

  const userId = parseInt(params.userId);
  if (isNaN(userId) || userId === 0) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  const body = await request.json();
  const { isAdmin } = ToggleAdminSchema.parse(body);

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
});
