import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create default location if it doesn't exist
  const existingLocation = await prisma.location.findUnique({
    where: { id: 1 },
  });

  if (!existingLocation) {
    const location = await prisma.location.create({
      data: {
        id: 1,
        name: 'Main Warehouse',
      },
    });
    console.log('Created default location:', location);
  } else {
    console.log('Default location already exists:', existingLocation);
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