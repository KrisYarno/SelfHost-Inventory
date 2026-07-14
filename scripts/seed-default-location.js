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
    // Bootstrap assertion (codex #6): the migrate job MUST fail loudly if the
    // default location is absent, rather than swallowing the error and letting
    // the app boot into FK violations on the first login. Nonzero exit here
    // aborts the compose `up` before the app swaps in.
    const loc = await prisma.location.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    if (!loc) {
      console.error('[seed] FAILED: default location id=1 missing after upsert');
      process.exitCode = 1;
      return;
    }
    console.log('[seed] Default location ensured (id=1)');
  } catch (e) {
    console.error('[seed] FAILED:', e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
