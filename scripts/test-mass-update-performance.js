#!/usr/bin/env node

/**
 * Test script to measure performance improvements from new indexes
 * for the mass inventory update feature
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});

async function measureQueryTime(name, queryFn) {
  const start = Date.now();
  const result = await queryFn();
  const duration = Date.now() - start;
  console.log(`${name}: ${duration}ms`);
  return { result, duration };
}

async function testProductSearch() {
  console.log('\n=== Testing Product Search Performance ===');
  
  const searchTerm = 'test';
  
  // Test case-insensitive search
  await measureQueryTime('Product search (name)', async () => {
    return await prisma.product.findMany({
      where: {
        name: {
          contains: searchTerm,
          mode: 'insensitive',
        },
      },
      take: 50,
    });
  });
  
  // Test multi-field search
  await measureQueryTime('Product search (all fields)', async () => {
    return await prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: searchTerm, mode: 'insensitive' } },
          { baseName: { contains: searchTerm, mode: 'insensitive' } },
          { variant: { contains: searchTerm, mode: 'insensitive' } },
        ],
      },
      take: 50,
    });
  });
}

async function testInventoryLogLookups() {
  console.log('\n=== Testing Inventory Log Lookups ===');
  
  // Get a sample product and location
  const product = await prisma.product.findFirst();
  const location = await prisma.location.findFirst();
  
  if (!product || !location) {
    console.log('No products or locations found for testing');
    return;
  }
  
  // Test finding last update for product/location
  await measureQueryTime('Last update lookup (single)', async () => {
    return await prisma.inventory_logs.findFirst({
      where: {
        productId: product.id,
        locationId: location.id,
      },
      orderBy: {
        changeTime: 'desc',
      },
      select: {
        changeTime: true,
      },
    });
  });
  
  // Test batch lookup of last updates
  const productIds = await prisma.product.findMany({
    take: 100,
    select: { id: true },
  });
  
  await measureQueryTime('Last update lookup (batch 100)', async () => {
    const promises = productIds.map(p => 
      prisma.inventory_logs.findFirst({
        where: {
          productId: p.id,
          locationId: location.id,
        },
        orderBy: {
          changeTime: 'desc',
        },
        select: {
          changeTime: true,
        },
      })
    );
    return await Promise.all(promises);
  });
}

async function testProductLocationLookups() {
  console.log('\n=== Testing Product Location Lookups ===');
  
  const location = await prisma.location.findFirst();
  if (!location) {
    console.log('No locations found for testing');
    return;
  }
  
  // Test single product location lookup
  const product = await prisma.product.findFirst();
  if (product) {
    await measureQueryTime('Product location lookup (single)', async () => {
      return await prisma.product_locations.findUnique({
        where: {
          productId_locationId: {
            productId: product.id,
            locationId: location.id,
          },
        },
        select: {
          quantity: true,
          version: true,
        },
      });
    });
  }
  
  // Test bulk product location lookups
  const productIds = await prisma.product.findMany({
    take: 100,
    select: { id: true },
  });
  
  await measureQueryTime('Product location lookup (bulk 100)', async () => {
    return await prisma.product_locations.findMany({
      where: {
        productId: { in: productIds.map(p => p.id) },
        locationId: location.id,
      },
      select: {
        productId: true,
        quantity: true,
        version: true,
      },
    });
  });
}

async function testMassUpdateQueries() {
  console.log('\n=== Testing Mass Update Query Patterns ===');
  
  const location = await prisma.location.findFirst();
  if (!location) {
    console.log('No locations found for testing');
    return;
  }
  
  // Test loading products with quantities (journal page load)
  await measureQueryTime('Load products with quantities', async () => {
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      take: 50,
      orderBy: { name: 'asc' },
    });
    
    const productIds = products.map(p => p.id);
    
    const productLocations = await prisma.product_locations.findMany({
      where: {
        productId: { in: productIds },
        locationId: location.id,
      },
      select: {
        productId: true,
        quantity: true,
        version: true,
      },
    });
    
    return { products, productLocations };
  });
  
  // Test version check queries (optimistic locking)
  const productWithLocation = await prisma.product_locations.findFirst({
    where: { locationId: location.id },
  });
  
  if (productWithLocation) {
    await measureQueryTime('Version check for optimistic locking', async () => {
      return await prisma.product_locations.findUnique({
        where: {
          productId_locationId: {
            productId: productWithLocation.productId,
            locationId: productWithLocation.locationId,
          },
        },
        select: {
          version: true,
          quantity: true,
        },
      });
    });
  }
}

async function main() {
  console.log('Testing Mass Update Performance...');
  console.log('==================================');
  
  try {
    await testProductSearch();
    await testInventoryLogLookups();
    await testProductLocationLookups();
    await testMassUpdateQueries();
    
    console.log('\n=== Test Complete ===');
    console.log('\nNote: Run this script before and after applying the migration to compare performance.');
  } catch (error) {
    console.error('Error during testing:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);