import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { encryptValue } from "@/lib/encryption";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/integrations
 * List all integrations (admin only)
 */
export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch all integrations with company info
    const integrations = await prisma.integration.findMany({
      select: {
        id: true,
        companyId: true,
        platform: true,
        name: true,
        storeUrl: true,
        isActive: true,
        lastSyncAt: true,
        createdAt: true,
        updatedAt: true,
        company: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
      orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
    });

    return NextResponse.json({ integrations });
  } catch (error) {
    console.error("Error fetching integrations:", error);
    return NextResponse.json(
      { error: "Failed to fetch integrations" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/integrations
 * Create new integration (encrypt credentials)
 */
export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      companyId,
      platform,
      name,
      storeUrl,
      apiKey,
      apiSecret,
      webhookSecret,
    } = body;

    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : apiKey;
    const normalizedApiSecret =
      typeof apiSecret === "string" ? apiSecret.trim() : apiSecret;
    const normalizedWebhookSecret =
      typeof webhookSecret === "string" ? webhookSecret.trim() : webhookSecret;
    const normalizedStoreUrl =
      typeof storeUrl === "string" ? storeUrl.trim() : storeUrl;

    // Validate input
    if (
      !companyId ||
      !platform ||
      !name ||
      !normalizedStoreUrl ||
      !normalizedApiKey ||
      !normalizedApiSecret
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Validate platform
    if (platform !== "SHOPIFY" && platform !== "WOOCOMMERCE") {
      return NextResponse.json(
        { error: "Invalid platform. Must be SHOPIFY or WOOCOMMERCE" },
        { status: 400 }
      );
    }

    // Validate URL
    try {
      new URL(normalizedStoreUrl);
    } catch {
      return NextResponse.json(
        { error: "Invalid store URL" },
        { status: 400 }
      );
    }

    // Check if company exists
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      return NextResponse.json(
        { error: "Company not found" },
        { status: 404 }
      );
    }

    const resolvedWebhookSecret =
      typeof normalizedWebhookSecret === "string" &&
      normalizedWebhookSecret.length > 0
        ? normalizedWebhookSecret
        : platform === "SHOPIFY"
          ? normalizedApiSecret
          : process.env.WOOCOMMERCE_WEBHOOK_SECRET;

    if (!resolvedWebhookSecret) {
      return NextResponse.json(
        {
          error:
            "Webhook secret is required for WooCommerce integrations (or set WOOCOMMERCE_WEBHOOK_SECRET).",
        },
        { status: 400 }
      );
    }

    // Encrypt credentials before storing
    const encryptedApiKey = encryptValue(normalizedApiKey);
    const encryptedApiSecret = encryptValue(normalizedApiSecret);
    const encryptedWebhookSecret = encryptValue(resolvedWebhookSecret);

    // Create integration
    const integration = await prisma.integration.create({
      data: {
        companyId,
        platform,
        name,
        storeUrl: normalizedStoreUrl,
        encryptedApiKey,
        encryptedApiSecret,
        webhookSecret: encryptedWebhookSecret,
        isActive: true,
      },
      include: {
        company: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    });

    return NextResponse.json({ integration }, { status: 201 });
  } catch (error) {
    console.error("Error creating integration:", error);
    return NextResponse.json(
      { error: "Failed to create integration" },
      { status: 500 }
    );
  }
}
