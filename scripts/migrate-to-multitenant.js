#!/usr/bin/env node

/**
 * Migration Script: Migrate to Multi-tenant Architecture
 *
 * This script:
 * 1. Creates a "Default Company" with slug "default"
 * 2. Assigns all existing Users to this Company via UserCompany
 *
 * Products are GLOBAL (shared inventory) and do NOT belong to companies.
 *
 * This script is idempotent and safe to run multiple times.
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const DEFAULT_COMPANY_SLUG = "default";
const DEFAULT_COMPANY_NAME = "Default Company";

async function main() {
  console.log("Starting migration to multi-tenant architecture...");

  const defaultCompany =
    (await prisma.company.findUnique({
      where: { slug: DEFAULT_COMPANY_SLUG },
    })) ||
    (await prisma.company.create({
      data: { name: DEFAULT_COMPANY_NAME, slug: DEFAULT_COMPANY_SLUG },
    }));

  const companyId = defaultCompany.id;

  const users = await prisma.user.findMany({ select: { id: true } });

  for (const user of users) {
    await prisma.userCompany.upsert({
      where: { userId_companyId: { userId: user.id, companyId } },
      create: { userId: user.id, companyId },
      update: {},
    });
  }

  console.log(`Default company: ${defaultCompany.slug} (${defaultCompany.id})`);
  console.log(`Users processed: ${users.length}`);
  console.log("Multi-tenant migration complete.");
}

main()
  .catch((error) => {
    console.error("Multi-tenant migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

