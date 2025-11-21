#!/usr/bin/env node
/**
 * Read-only analysis of products to see how many rows are missing key fields.
 * Safe to run in any environment; does not modify data.
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const total = await prisma.product.count();
  const missingBase = await prisma.product.count({ where: { baseName: null } });
  const missingNumeric = await prisma.product.count({ where: { numericValue: null } });
  const missingVariant = await prisma.product.count({ where: { variant: null } });
  const softDeleted = await prisma.product.count({ where: { deletedAt: { not: null } } });

  const lacksStructure = await prisma.product.count({
    where: {
      OR: [
        { baseName: null },
        { variant: null },
        { numericValue: null, unit: { not: null } },
        { numericValue: { not: null }, unit: null },
      ],
    },
  });

  const topUnits = await prisma.product.groupBy({
    by: ["unit"],
    _count: { unit: true },
    orderBy: { _count: { unit: "desc" } },
    where: { unit: { not: null } },
    take: 10,
  });

  console.log("Product invariant snapshot");
  console.log("---------------------------");
  console.log(`Total products: ${total}`);
  console.log(`Missing baseName: ${missingBase}`);
  console.log(`Missing numericValue: ${missingNumeric}`);
  console.log(`Missing variant: ${missingVariant}`);
  console.log(`Soft-deleted: ${softDeleted}`);
  console.log(`Lacks structure (see OR filters): ${lacksStructure}`);
  console.log("Top units:");
  topUnits.forEach((u) => console.log(`  ${u.unit || "(null)"}: ${u._count.unit}`));
}

main()
  .catch((err) => {
    console.error("Analysis failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
