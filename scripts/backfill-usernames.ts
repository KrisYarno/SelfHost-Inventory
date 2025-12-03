/**
 * Backfill script for users without usernames
 *
 * This script generates usernames for existing users that have empty or missing usernames.
 * Run with: npx ts-node scripts/backfill-usernames.ts
 * Or: npx tsx scripts/backfill-usernames.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function backfillUsernames() {
  console.log("Starting username backfill...\n");

  // Find users with empty or missing usernames
  const usersWithoutUsername = await prisma.user.findMany({
    where: {
      OR: [{ username: "" }, { username: null as unknown as string }],
    },
    select: {
      id: true,
      email: true,
      username: true,
    },
  });

  console.log(`Found ${usersWithoutUsername.length} users without usernames.\n`);

  if (usersWithoutUsername.length === 0) {
    console.log("No users need username backfill.");
    return;
  }

  // Get all existing usernames for uniqueness checking
  const existingUsernames = await prisma.user.findMany({
    where: {
      username: { not: "" },
    },
    select: { username: true },
  });

  const usedUsernames = new Set(existingUsernames.map((u) => u.username.toLowerCase()));

  let updated = 0;
  let skipped = 0;

  for (const user of usersWithoutUsername) {
    // Generate username from email prefix
    const baseUsername = user.email.split("@")[0].toLowerCase().replace(/[^a-z0-9.]/g, "");

    // Find a unique username
    let candidateUsername = baseUsername;
    let suffix = 1;

    while (usedUsernames.has(candidateUsername)) {
      candidateUsername = `${baseUsername}${suffix}`;
      suffix++;

      // Safety check to prevent infinite loops
      if (suffix > 1000) {
        console.warn(`Could not generate unique username for user ${user.id} (${user.email})`);
        skipped++;
        continue;
      }
    }

    // Update the user
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { username: candidateUsername },
      });

      usedUsernames.add(candidateUsername);
      console.log(`Updated user ${user.id}: ${user.email} -> username: "${candidateUsername}"`);
      updated++;
    } catch (error) {
      console.error(`Failed to update user ${user.id}:`, error);
      skipped++;
    }
  }

  console.log(`\nBackfill complete!`);
  console.log(`- Updated: ${updated} users`);
  console.log(`- Skipped: ${skipped} users`);
}

backfillUsernames()
  .catch((error) => {
    console.error("Backfill script failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
