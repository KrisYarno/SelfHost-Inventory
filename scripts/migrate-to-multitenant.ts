#!/usr/bin/env ts-node

/**
 * Migration Script: Migrate to Multi-tenant Architecture
 *
 * This script:
 * 1. Creates a "Default Company" with slug "default"
 * 2. Assigns all existing Users to this Company via UserCompany
 *
 * NOTE: Products are GLOBAL (shared inventory) and do NOT belong to companies.
 * Products are linked to company integrations via the ProductLink table.
 *
 * This script is idempotent and can be run multiple times safely.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_COMPANY_SLUG = 'default';
const DEFAULT_COMPANY_NAME = 'Default Company';

async function main() {
  console.log('🚀 Starting migration to multi-tenant architecture...\n');

  try {
    // Step 1: Create or find Default Company
    console.log('📦 Step 1: Creating/finding Default Company...');

    let defaultCompany = await prisma.company.findUnique({
      where: { slug: DEFAULT_COMPANY_SLUG },
    });

    if (defaultCompany) {
      console.log(`✅ Default Company already exists (ID: ${defaultCompany.id})`);
    } else {
      defaultCompany = await prisma.company.create({
        data: {
          name: DEFAULT_COMPANY_NAME,
          slug: DEFAULT_COMPANY_SLUG,
        },
      });
      console.log(`✅ Created Default Company (ID: ${defaultCompany.id})`);
    }

    const companyId = defaultCompany.id;

    // Step 2: Assign all existing users to Default Company
    console.log('\n👥 Step 2: Assigning users to Default Company...');

    const allUsers = await prisma.user.findMany({
      select: { id: true, email: true },
    });

    console.log(`Found ${allUsers.length} users to process`);

    let usersAssigned = 0;
    let usersSkipped = 0;

    for (const user of allUsers) {
      // Check if user already assigned to this company
      const existing = await prisma.userCompany.findUnique({
        where: {
          userId_companyId: {
            userId: user.id,
            companyId: companyId,
          },
        },
      });

      if (existing) {
        usersSkipped++;
        continue;
      }

      // Create the user-company relationship
      await prisma.userCompany.create({
        data: {
          userId: user.id,
          companyId: companyId,
        },
      });

      usersAssigned++;

      if (usersAssigned % 10 === 0) {
        console.log(`  Assigned ${usersAssigned} users...`);
      }
    }

    console.log(`✅ Assigned ${usersAssigned} users to Default Company`);
    if (usersSkipped > 0) {
      console.log(`ℹ️  Skipped ${usersSkipped} users (already assigned)`);
    }

    // Step 3: Verification
    console.log('\n🔍 Step 3: Verifying migration...');

    const companyStats = await prisma.company.findUnique({
      where: { id: companyId },
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

    const totalProducts = await prisma.product.count({
      where: { deletedAt: null },
    });

    console.log('\n📊 Migration Summary:');
    console.log(`  Company: ${companyStats?.name} (${companyStats?.slug})`);
    console.log(`  Users assigned: ${companyStats?._count.users}`);
    console.log(`  Integrations: ${companyStats?._count.integrations}`);
    console.log(`  External Orders: ${companyStats?._count.orders}`);
    console.log(`  Global Products (shared inventory): ${totalProducts}`);

    console.log('\n✅ Migration completed successfully!');
    console.log('\nℹ️  Note: Products are GLOBAL and shared across all companies.');
    console.log('   Use ProductLink to map products to specific integrations.\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
