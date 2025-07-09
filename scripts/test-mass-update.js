#!/usr/bin/env node

/**
 * Test script for mass update API without notes field
 * 
 * This script verifies that the journal mass update endpoint
 * now works correctly without requiring the notes field.
 */

const https = require('https');

// Test configuration
const TEST_CONFIG = {
  host: 'localhost',
  port: 3000,
  path: '/api/inventory/adjust',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  }
};

// Sample test data - mass update without notes
const testData = {
  userId: 'test-user-123',
  locationId: 'test-location-456',
  changes: [
    {
      productId: 'prod-001',
      changeType: 'increase',
      value: 5,
      reason: 'restocking',
      // No notes field - this should now work!
    },
    {
      productId: 'prod-002',
      changeType: 'decrease',
      value: 3,
      reason: 'damaged',
      // No notes field here either
    },
    {
      productId: 'prod-003',
      changeType: 'set',
      value: 100,
      reason: 'cycle_count',
      // This one has notes to show it's still optional
      notes: 'Monthly inventory count'
    }
  ]
};

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function makeRequest(data) {
  return new Promise((resolve, reject) => {
    const jsonData = JSON.stringify(data);
    
    const options = {
      ...TEST_CONFIG,
      headers: {
        ...TEST_CONFIG.headers,
        'Content-Length': Buffer.byteLength(jsonData)
      }
    };

    console.log(`${colors.blue}📤 Sending request to ${options.host}:${options.port}${options.path}${colors.reset}`);
    console.log(`${colors.cyan}Request body:${colors.reset}`);
    console.log(JSON.stringify(data, null, 2));
    console.log('');

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseData
        });
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(jsonData);
    req.end();
  });
}

async function runTest() {
  console.log(`${colors.yellow}🧪 Testing Mass Update API (without notes field)${colors.reset}`);
  console.log('='.repeat(50));
  console.log('');

  try {
    const response = await makeRequest(testData);
    
    console.log(`${colors.blue}📥 Response received:${colors.reset}`);
    console.log(`Status Code: ${response.statusCode}`);
    console.log(`Headers:`, response.headers);
    console.log('');

    let parsedBody;
    try {
      parsedBody = JSON.parse(response.body);
      console.log(`${colors.cyan}Response body:${colors.reset}`);
      console.log(JSON.stringify(parsedBody, null, 2));
    } catch (e) {
      console.log(`${colors.cyan}Response body (raw):${colors.reset}`);
      console.log(response.body);
    }

    console.log('');
    console.log('='.repeat(50));

    // Check if the request was successful
    if (response.statusCode === 200 || response.statusCode === 201) {
      console.log(`${colors.green}✅ SUCCESS: Mass update API works without notes field!${colors.reset}`);
      console.log(`${colors.green}   - Status code: ${response.statusCode}${colors.reset}`);
      if (parsedBody && parsedBody.success) {
        console.log(`${colors.green}   - Response indicates success${colors.reset}`);
      }
    } else {
      console.log(`${colors.red}❌ FAILED: Mass update API returned error${colors.reset}`);
      console.log(`${colors.red}   - Status code: ${response.statusCode}${colors.reset}`);
      if (parsedBody && parsedBody.error) {
        console.log(`${colors.red}   - Error: ${parsedBody.error}${colors.reset}`);
      }
    }

  } catch (error) {
    console.log(`${colors.red}❌ ERROR: Request failed${colors.reset}`);
    console.log(`${colors.red}   ${error.message}${colors.reset}`);
    console.log(error.stack);
  }

  console.log('');
}

// Instructions
console.log(`${colors.yellow}📋 Mass Update API Test Script${colors.reset}`);
console.log('');
console.log('This script tests the journal mass update endpoint to verify');
console.log('that it now works correctly without requiring the notes field.');
console.log('');
console.log(`${colors.cyan}To use this script:${colors.reset}`);
console.log('');
console.log('1. Make sure your Next.js app is running:');
console.log(`   ${colors.blue}npm run dev${colors.reset}`);
console.log('');
console.log('2. Run this test script:');
console.log(`   ${colors.blue}node scripts/test-mass-update.js${colors.reset}`);
console.log('');
console.log('3. For production testing, modify the host/port in the script');
console.log('   and add any required authentication headers.');
console.log('');
console.log('='.repeat(50));
console.log('');

// Check if we should run the test immediately
if (process.argv.includes('--run')) {
  runTest();
} else {
  console.log(`${colors.yellow}Add --run flag to execute the test now${colors.reset}`);
  console.log(`Example: ${colors.blue}node scripts/test-mass-update.js --run${colors.reset}`);
}