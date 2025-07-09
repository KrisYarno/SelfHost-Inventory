#!/usr/bin/env node

/**
 * Test script for mass update pagination API
 * Usage: node scripts/test-mass-update-pagination.js
 */

const ADMIN_SESSION_TOKEN = process.env.ADMIN_SESSION_TOKEN;
const BASE_URL = process.env.NEXT_PUBLIC_URL || 'http://localhost:3000';

async function testPagination() {
  if (!ADMIN_SESSION_TOKEN) {
    console.error('❌ ADMIN_SESSION_TOKEN environment variable is required');
    console.log('Please set it with: export ADMIN_SESSION_TOKEN=your-session-token');
    process.exit(1);
  }

  console.log('🧪 Testing Mass Update Pagination API...\n');

  const headers = {
    'Cookie': `next-auth.session-token=${ADMIN_SESSION_TOKEN}`,
    'Content-Type': 'application/json',
  };

  try {
    // Test 1: Fetch without pagination (backward compatibility)
    console.log('📋 Test 1: Fetching all products (no pagination)...');
    const allResponse = await fetch(`${BASE_URL}/api/admin/inventory/mass-update`, {
      headers
    });
    const allData = await allResponse.json();
    
    if (allResponse.ok) {
      console.log(`✅ Success: Retrieved ${allData.totalProducts} products`);
      console.log(`   - No pagination metadata: ${!allData.pagination ? '✓' : '✗'}`);
    } else {
      console.log(`❌ Failed: ${allData.error}`);
    }

    // Test 2: Fetch with pagination
    console.log('\n📋 Test 2: Fetching page 0 with pageSize 10...');
    const page0Response = await fetch(`${BASE_URL}/api/admin/inventory/mass-update?page=0&pageSize=10`, {
      headers
    });
    const page0Data = await page0Response.json();
    
    if (page0Response.ok) {
      console.log(`✅ Success: Retrieved ${page0Data.products.length} products`);
      if (page0Data.pagination) {
        console.log(`   - Page: ${page0Data.pagination.page}`);
        console.log(`   - Page Size: ${page0Data.pagination.pageSize}`);
        console.log(`   - Total Pages: ${page0Data.pagination.totalPages}`);
        console.log(`   - Total Items: ${page0Data.pagination.totalItems}`);
        console.log(`   - Has Next: ${page0Data.pagination.hasNext}`);
        console.log(`   - Has Previous: ${page0Data.pagination.hasPrevious}`);
      }
    } else {
      console.log(`❌ Failed: ${page0Data.error}`);
    }

    // Test 3: Fetch different page
    console.log('\n📋 Test 3: Fetching page 1 with pageSize 5...');
    const page1Response = await fetch(`${BASE_URL}/api/admin/inventory/mass-update?page=1&pageSize=5`, {
      headers
    });
    const page1Data = await page1Response.json();
    
    if (page1Response.ok) {
      console.log(`✅ Success: Retrieved ${page1Data.products.length} products`);
      if (page1Data.pagination) {
        console.log(`   - Page: ${page1Data.pagination.page}`);
        console.log(`   - Has Previous: ${page1Data.pagination.hasPrevious}`);
      }
    } else {
      console.log(`❌ Failed: ${page1Data.error}`);
    }

    // Test 4: Search with pagination
    console.log('\n📋 Test 4: Search with pagination...');
    const searchResponse = await fetch(`${BASE_URL}/api/admin/inventory/mass-update?search=test&page=0&pageSize=10`, {
      headers
    });
    const searchData = await searchResponse.json();
    
    if (searchResponse.ok) {
      console.log(`✅ Success: Found ${searchData.totalProducts} products matching "test"`);
      console.log(`   - Showing ${searchData.products.length} on this page`);
    } else {
      console.log(`❌ Failed: ${searchData.error}`);
    }

    // Test 5: Performance test - large page size
    console.log('\n📋 Test 5: Performance test with large page size...');
    const startTime = Date.now();
    const perfResponse = await fetch(`${BASE_URL}/api/admin/inventory/mass-update?page=0&pageSize=100`, {
      headers
    });
    const perfData = await perfResponse.json();
    const endTime = Date.now();
    
    if (perfResponse.ok) {
      console.log(`✅ Success: Retrieved ${perfData.products.length} products in ${endTime - startTime}ms`);
    } else {
      console.log(`❌ Failed: ${perfData.error}`);
    }

    console.log('\n✨ All tests completed!');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  }
}

// Run tests
testPagination();