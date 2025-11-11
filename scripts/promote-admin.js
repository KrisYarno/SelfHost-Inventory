const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function promote(emails) {
  for (const raw of emails) {
    const email = (raw || '').toLowerCase().trim();
    if (!email) continue;

    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        await prisma.user.update({
          where: { email },
          data: { isAdmin: true, isApproved: true },
        });
        console.log(`[promote] Updated ${email} -> isAdmin=true, isApproved=true`);
      } else {
        await prisma.user.create({
          data: {
            email,
            username: email.split('@')[0],
            passwordHash: '',
            isAdmin: true,
            isApproved: true,
            defaultLocationId: 1,
          },
        });
        console.log(`[promote] Created ${email} as admin + approved`);
      }
    } catch (err) {
      console.error(`[promote] Failed for ${email}:`, err.message);
      process.exitCode = 1;
    }
  }
}

(async () => {
  const cli = process.argv.slice(2);
  const fromEnv = (process.env.BOOTSTRAP_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const emails = cli.length ? cli : fromEnv;
  if (!emails.length) {
    console.error('Usage: node scripts/promote-admin.js user@example.com [other@example.com]');
    console.error('Or set BOOTSTRAP_ADMIN_EMAILS in env (comma-separated).');
    process.exit(2);
  }
  await promote(emails);
  await prisma.$disconnect();
})();

