import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { UpdateUserSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

async function resolveCompanyNamesById(companyIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(companyIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const companies = await prisma.company.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(companies.map((c) => [c.id, c.name]));
}

// Schema for validating company association
interface CompanyAssociation {
  companyId: string;
}

// Schema for PATCH request body
interface UpdateUserBody {
  username?: string;
  defaultLocationId?: number;
  isAdmin?: boolean;
  emailAlerts?: boolean;
  minLocationEmailAlerts?: boolean;
  minCombinedEmailAlerts?: boolean;
  companies?: CompanyAssociation[];
}

export const PATCH = apiHandler(async (
  request: NextRequest,
  { params }: { params: { userId: string } }
) => {
  const { user: adminUser } = await requireAdmin();

  await requireCSRF(request);

  const userId = parseInt(params.userId);
  if (isNaN(userId) || userId === 0) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  // Get the user being edited
  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      companies: true,
    },
  });

  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (targetUser.deletedAt) {
    return NextResponse.json({ error: "Cannot edit deleted user" }, { status: 400 });
  }

  const body: UpdateUserBody = await request.json();

  // Validate core fields with Zod schema
  const coreFields = {
    ...(body.username !== undefined && { username: body.username }),
    ...(body.isAdmin !== undefined && { isAdmin: body.isAdmin }),
    ...(body.defaultLocationId !== undefined && { defaultLocationId: body.defaultLocationId }),
  };
  if (Object.keys(coreFields).length > 0) {
    UpdateUserSchema.parse(coreFields);
  }

  // Validate defaultLocationId if provided
  if (body.defaultLocationId !== undefined) {
    const location = await prisma.location.findUnique({
      where: { id: body.defaultLocationId },
    });
    if (!location) {
      return NextResponse.json(
        { error: "Invalid default location" },
        { status: 400 }
      );
    }
  }

  // Validate company associations if provided
  if (body.companies !== undefined) {
    for (const assoc of body.companies) {
      if (!assoc.companyId) {
        return NextResponse.json(
          { error: "Invalid company association: each must have companyId" },
          { status: 400 }
        );
      }
    }

    // Verify all company IDs exist
    const companyIds = body.companies.map((c) => c.companyId);
    const existingCompanies = await prisma.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true },
    });

    if (existingCompanies.length !== companyIds.length) {
      return NextResponse.json(
        { error: "One or more company IDs are invalid" },
        { status: 400 }
      );
    }
  }

  // Prevent admin from removing their own admin status
  if (body.isAdmin === false && adminUser.id === userId) {
    return NextResponse.json(
      { error: "Cannot remove your own admin status" },
      { status: 400 }
    );
  }

  // Build the user update data
  const updateData: Record<string, any> = {};
  const changes: Record<string, { from: any; to: any }> = {};

  if (body.username !== undefined && body.username !== targetUser.username) {
    updateData.username = body.username;
    changes.username = { from: targetUser.username, to: body.username };
  }

  if (body.defaultLocationId !== undefined && body.defaultLocationId !== targetUser.defaultLocationId) {
    updateData.defaultLocationId = body.defaultLocationId;
    changes.defaultLocationId = { from: targetUser.defaultLocationId, to: body.defaultLocationId };
  }

  if (body.isAdmin !== undefined && body.isAdmin !== targetUser.isAdmin) {
    updateData.isAdmin = body.isAdmin;
    changes.isAdmin = { from: targetUser.isAdmin, to: body.isAdmin };
  }

  if (body.emailAlerts !== undefined && body.emailAlerts !== targetUser.emailAlerts) {
    updateData.emailAlerts = body.emailAlerts;
    changes.emailAlerts = { from: targetUser.emailAlerts, to: body.emailAlerts };
  }

  if (body.minLocationEmailAlerts !== undefined && body.minLocationEmailAlerts !== targetUser.minLocationEmailAlerts) {
    updateData.minLocationEmailAlerts = body.minLocationEmailAlerts;
    changes.minLocationEmailAlerts = { from: targetUser.minLocationEmailAlerts, to: body.minLocationEmailAlerts };
  }

  if (body.minCombinedEmailAlerts !== undefined && body.minCombinedEmailAlerts !== targetUser.minCombinedEmailAlerts) {
    updateData.minCombinedEmailAlerts = body.minCombinedEmailAlerts;
    changes.minCombinedEmailAlerts = { from: targetUser.minCombinedEmailAlerts, to: body.minCombinedEmailAlerts };
  }

  // One batchId per request ties the USER_UPDATE event to the additional
  // USER_ROLE_CHANGE event emitted when isAdmin flips (spec D6: privilege
  // escalation is queryable on its own AND grouped with the update it rode in
  // on). Replaces the deleted audit singleton's startBatch/endBatch.
  const batchId = newBatchId();

  // Handle company associations in a transaction
  const result = await prisma.$transaction(async (tx) => {
    // Update user fields if any changed
    let updatedUser = targetUser;
    if (Object.keys(updateData).length > 0) {
      updatedUser = await tx.user.update({
        where: { id: userId },
        data: updateData,
        include: { companies: true },
      });
    }

    // Handle company associations if provided
    if (body.companies !== undefined) {
      // Get current company associations
      const currentCompanyIds = targetUser.companies.map((c) => c.companyId);
      const newCompanyIds = body.companies.map((c) => c.companyId);

      // Find removed and added companies
      const removedCompanyIds = currentCompanyIds.filter((id) => !newCompanyIds.includes(id));
      const addedCompanies = body.companies.filter((c) => !currentCompanyIds.includes(c.companyId));

      // Delete removed associations
      if (removedCompanyIds.length > 0) {
        await tx.userCompany.deleteMany({
          where: {
            userId,
            companyId: { in: removedCompanyIds },
          },
        });
      }

      // Add new associations
      if (addedCompanies.length > 0) {
        await tx.userCompany.createMany({
          data: addedCompanies.map((c) => ({
            userId,
            companyId: c.companyId,
          })),
        });
      }

      // Track company changes
      if (removedCompanyIds.length > 0 || addedCompanies.length > 0) {
        changes.companies = {
          from: targetUser.companies.map((c) => ({ companyId: c.companyId })),
          to: body.companies,
        };
      }

      // Re-fetch user with updated companies
      updatedUser = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: { companies: true },
      });
    }

    // Record the change inside the SAME transaction as the mutation — an
    // unrecordable admin edit must not commit (spec R-D2). `changes` already
    // holds the full field-level diff (including companies, computed above).
    if (Object.keys(changes).length > 0) {
      await recordChange(tx, {
        actor: { userId: adminUser.id },
        actionType: "USER_UPDATE",
        entityType: "USER",
        entityId: userId,
        action: `Updated user ${targetUser.email}`,
        changes,
        details: { targetEmail: targetUser.email },
        batchId,
      });

      // Privilege escalation gets its own queryable event alongside the
      // USER_UPDATE, sharing the same batchId (spec D6). Emitted only when the
      // admin flag actually changed.
      if (changes.isAdmin) {
        await recordChange(tx, {
          actor: { userId: adminUser.id },
          actionType: "USER_ROLE_CHANGE",
          entityType: "USER",
          entityId: userId,
          action: `Changed admin role for user ${targetUser.email}`,
          changes: { isAdmin: changes.isAdmin },
          details: { targetEmail: targetUser.email },
          batchId,
        });
      }
    }

    return updatedUser;
  });

  const companyNameById = await resolveCompanyNamesById(
    (result as any).companies?.map((c: any) => c.companyId) ?? []
  );

  return NextResponse.json({
    message: "User updated successfully",
    user: {
      id: result.id,
      username: result.username,
      email: result.email,
      isAdmin: result.isAdmin,
      isApproved: result.isApproved,
      defaultLocationId: result.defaultLocationId,
      emailAlerts: result.emailAlerts,
      minLocationEmailAlerts: result.minLocationEmailAlerts,
      minCombinedEmailAlerts: result.minCombinedEmailAlerts,
      companies: (result as any).companies?.map((c: any) => ({
        companyId: c.companyId,
        companyName: companyNameById.get(c.companyId) ?? "(deleted company)",
      })),
    },
  });
});

export const DELETE = apiHandler(async (request: NextRequest, { params }: { params: { userId: string } }) => {
  const { user: adminUser } = await requireAdmin();

  await requireCSRF(request);

  const userId = parseInt(params.userId);
  if (isNaN(userId) || userId === 0) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  // Prevent deleting yourself
  if (adminUser.id === userId) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  // Fetch the target inside the tx (honest 404 if missing — a bare update on a
  // missing id used to 500), soft-delete, and record USER_DELETION with the
  // deletedAt transition + a redacted full-row snapshot (R-D11). recordChange
  // auto-redacts passwordHash inside the snapshot.
  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId } });
    if (!target) {
      throw new AppError("User not found", "NOT_FOUND", 404);
    }

    const deletedAt = new Date();
    await tx.user.update({
      where: { id: userId },
      data: { deletedAt },
    });

    // Lane 4 (D7): a soft-deleted user can no longer be a valid token owner
    // (owner must be deletedAt IS NULL AND isApproved at every validation), so
    // revoke every active token they own inside the SAME transaction — the
    // deletion and the revocations commit together or not at all.
    await tx.apiToken.updateMany({
      where: { ownerUserId: userId, revokedAt: null },
      data: { revokedAt: deletedAt },
    });

    await recordChange(tx, {
      actor: { userId: adminUser.id },
      actionType: "USER_DELETION",
      entityType: "USER",
      entityId: userId,
      action: `Deleted user ${target.email}`,
      changes: { deletedAt: { from: target.deletedAt, to: deletedAt } },
      details: { snapshot: target },
    });
  });

  return NextResponse.json({
    message: "User deleted successfully",
  });
});
