import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding locations...');

  // Create default locations
  const locations = [
    { id: 1, name: 'Main Warehouse' },
    { id: 2, name: 'Store Front' },
    { id: 3, name: 'Secondary Storage' },
  ];

  for (const location of locations) {
    await prisma.location.upsert({
      where: { id: location.id },
      update: { name: location.name },
      create: location,
    });
    console.log(`Upserted location: ${location.name}`);
  }

  // Ensure all existing products have product_locations entries for location 1
  const products = await prisma.product.findMany();
  console.log(`Found ${products.length} products`);

  for (const product of products) {
    // Check if product_locations entry exists for location 1
    const existingEntry = await prisma.product_locations.findUnique({
      where: {
        productId_locationId: {
          productId: product.id,
          locationId: 1,
        },
      },
    });

    if (!existingEntry) {
      // Create entry with the quantity from the product table
      await prisma.product_locations.create({
        data: {
          productId: product.id,
          locationId: 1,
          quantity: product.quantity,
        },
      });
      console.log(`Created product_locations entry for product ${product.name} at Main Warehouse`);
    }
  }

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });