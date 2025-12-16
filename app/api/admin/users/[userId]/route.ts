import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

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
  phoneNumber?: string | null;
  minLocationEmailAlerts?: boolean;
  minLocationSmsAlerts?: boolean;
  minCombinedEmailAlerts?: boolean;
  minCombinedSmsAlerts?: boolean;
  companies?: CompanyAssociation[];
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

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

    // Validate username if provided
    if (body.username !== undefined) {
      if (typeof body.username !== "string" || body.username.length < 2 || body.username.length > 50) {
        return NextResponse.json(
          { error: "Username must be between 2 and 50 characters" },
          { status: 400 }
        );
      }
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

    // Validate phone number format if provided (basic validation)
    if (body.phoneNumber !== undefined && body.phoneNumber !== null && body.phoneNumber !== "") {
      const phoneRegex = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]*$/;
      if (!phoneRegex.test(body.phoneNumber)) {
        return NextResponse.json(
          { error: "Invalid phone number format" },
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
    if (body.isAdmin === false && session.user.id === userId) {
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

    if (body.phoneNumber !== undefined) {
      const newPhone = body.phoneNumber === "" ? null : body.phoneNumber;
      if (newPhone !== targetUser.phoneNumber) {
        updateData.phoneNumber = newPhone;
        changes.phoneNumber = { from: targetUser.phoneNumber, to: newPhone };
      }
    }

    if (body.minLocationEmailAlerts !== undefined && body.minLocationEmailAlerts !== targetUser.minLocationEmailAlerts) {
      updateData.minLocationEmailAlerts = body.minLocationEmailAlerts;
      changes.minLocationEmailAlerts = { from: targetUser.minLocationEmailAlerts, to: body.minLocationEmailAlerts };
    }

    if (body.minLocationSmsAlerts !== undefined && body.minLocationSmsAlerts !== targetUser.minLocationSmsAlerts) {
      updateData.minLocationSmsAlerts = body.minLocationSmsAlerts;
      changes.minLocationSmsAlerts = { from: targetUser.minLocationSmsAlerts, to: body.minLocationSmsAlerts };
    }

    if (body.minCombinedEmailAlerts !== undefined && body.minCombinedEmailAlerts !== targetUser.minCombinedEmailAlerts) {
      updateData.minCombinedEmailAlerts = body.minCombinedEmailAlerts;
      changes.minCombinedEmailAlerts = { from: targetUser.minCombinedEmailAlerts, to: body.minCombinedEmailAlerts };
    }

    if (body.minCombinedSmsAlerts !== undefined && body.minCombinedSmsAlerts !== targetUser.minCombinedSmsAlerts) {
      updateData.minCombinedSmsAlerts = body.minCombinedSmsAlerts;
      changes.minCombinedSmsAlerts = { from: targetUser.minCombinedSmsAlerts, to: body.minCombinedSmsAlerts };
    }

    // Handle company associations in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Update user fields if any changed
      let updatedUser = targetUser;
      if (Object.keys(updateData).length > 0) {
        updatedUser = await tx.user.update({
          where: { id: userId },
          data: updateData,
          include: { companies: { include: { company: true } } },
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
          include: { companies: { include: { company: true } } },
        });
      }

      return updatedUser;
    });

    // Log the update if there were changes
    if (Object.keys(changes).length > 0) {
      await auditService.log({
        userId: session.user.id,
        actionType: "USER_UPDATE",
        entityType: "USER",
        entityId: userId,
        action: `Updated user ${targetUser.email}`,
        details: {
          targetEmail: targetUser.email,
          changes,
        },
      });
    }

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
        phoneNumber: result.phoneNumber,
        minLocationEmailAlerts: result.minLocationEmailAlerts,
        minLocationSmsAlerts: result.minLocationSmsAlerts,
        minCombinedEmailAlerts: result.minCombinedEmailAlerts,
        minCombinedSmsAlerts: result.minCombinedSmsAlerts,
        companies: result.companies?.map((c: any) => ({
          companyId: c.companyId,
          companyName: c.company?.name,
        })),
      },
    });
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { userId: string } }) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const userId = parseInt(params.userId);
    if (isNaN(userId) || userId === 0) {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }

    // Prevent deleting yourself
    if (session.user.id === userId) {
      return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
    }

    // Soft delete - set deletedAt timestamp instead of hard deleting
    await prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });

    return NextResponse.json({
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json({ error: "Failed to delete user" }, { status: 500 });
  }
}
