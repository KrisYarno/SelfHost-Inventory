import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { encryptValue } from "@/lib/encryption";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/integrations/[id]
 * Get single integration (admin only)
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

    const integration = await prisma.integration.findUnique({
      where: { id: params.id },
      include: {
        company: {
          select: {
            name: true,
            slug: true,
          },
        },
        _count: {
          select: {
            orders: true,
            productLinks: true,
          },
        },
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    // Don't return encrypted credentials in GET
    const { encryptedApiKey, encryptedApiSecret, webhookSecret, ...safeData } =
      integration;

    return NextResponse.json({ integration: safeData });
  } catch (error) {
    console.error("Error fetching integration:", error);
    return NextResponse.json(
      { error: "Failed to fetch integration" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/integrations/[id]
 * Update integration
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
    const {
      name,
      storeUrl,
      apiKey,
      apiSecret,
      webhookSecret,
      isActive,
    } = body;

    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : apiKey;
    const normalizedApiSecret =
      typeof apiSecret === "string" ? apiSecret.trim() : apiSecret;
    const normalizedWebhookSecret =
      typeof webhookSecret === "string" ? webhookSecret.trim() : webhookSecret;

    // Validate URL if provided
    if (storeUrl) {
      try {
        new URL(storeUrl);
      } catch {
        return NextResponse.json(
          { error: "Invalid store URL" },
          { status: 400 }
        );
      }
    }

    // Build update data
    const updateData: any = {};

    if (name !== undefined) updateData.name = name;
    if (storeUrl !== undefined) updateData.storeUrl = storeUrl;
    if (isActive !== undefined) updateData.isActive = isActive;

    // Only update encrypted fields if new values are provided
    if (normalizedApiKey) {
      updateData.encryptedApiKey = encryptValue(normalizedApiKey);
    }
    if (normalizedApiSecret) {
      updateData.encryptedApiSecret = encryptValue(normalizedApiSecret);
    }
    if (normalizedWebhookSecret) {
      updateData.webhookSecret = encryptValue(normalizedWebhookSecret);
    }

    // Update integration
    const integration = await prisma.integration.update({
      where: { id: params.id },
      data: updateData,
      include: {
        company: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    });

    // Don't return encrypted credentials
    const { encryptedApiKey, encryptedApiSecret, webhookSecret: _, ...safeData } =
      integration;

    return NextResponse.json({ integration: safeData });
  } catch (error) {
    console.error("Error updating integration:", error);
    return NextResponse.json(
      { error: "Failed to update integration" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/integrations/[id]
 * Delete integration (and all associated data via cascade)
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

    // Check if integration exists
    const integration = await prisma.integration.findUnique({
      where: { id: params.id },
      include: {
        _count: {
          select: {
            orders: true,
            productLinks: true,
          },
        },
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    // Delete integration (cascade will delete orders, product links, etc.)
    await prisma.integration.delete({
      where: { id: params.id },
    });

    return NextResponse.json({
      success: true,
      message: "Integration deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting integration:", error);
    return NextResponse.json(
      { error: "Failed to delete integration" },
      { status: 500 }
    );
  }
}
