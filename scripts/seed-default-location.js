// Ensure a default location exists so new users with defaultLocationId=1 don't violate FKs
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    await prisma.location.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, name: 'Main' },
    });
    console.log('[seed] Default location ensured (id=1)');
  } catch (err) {
    console.error('[seed] Failed to ensure default location', err);
    // Don't fail the whole job; migrations already applied.
  } finally {
    await prisma.$disconnect();
  }
})();

