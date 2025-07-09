#!/usr/bin/env node

/**
 * API Diagnostics Script
 * 
 * Run this script to diagnose API connectivity issues:
 * node scripts/diagnose-api.js [base-url]
 * 
 * Examples:
 * node scripts/diagnose-api.js http://localhost:3000
 * node scripts/diagnose-api.js https://your-app.vercel.app
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Get base URL from command line or use default
const baseUrl = process.argv[2] || 'http://localhost:3000';
console.log(`${colors.cyan}🔍 Running API Diagnostics${colors.reset}`);
console.log(`${colors.blue}Base URL: ${baseUrl}${colors.reset}\n`);

// Test endpoints
const endpoints = [
  { path: '/api/products', method: 'GET', name: 'Products List' },
  { path: '/api/inventory/current', method: 'GET', name: 'Current Inventory' },
  { path: '/api/inventory/deduct', method: 'POST', name: 'Mass Update (Deduct)', body: { updates: [] } },
  { path: '/api/auth/session', method: 'GET', name: 'Auth Session' },
  { path: '/api/diagnostics', method: 'GET', name: 'Diagnostics' },
];

// Helper function to make HTTP requests
function makeRequest(url, options) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const req = protocol.request(parsedUrl, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: data,
        });
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    if (options.body) {
      req.write(options.body);
    }
    
    req.end();
  });
}

// Test a single endpoint
async function testEndpoint(endpoint) {
  const url = `${baseUrl}${endpoint.path}`;
  console.log(`${colors.bright}Testing: ${endpoint.name}${colors.reset}`);
  console.log(`${endpoint.method} ${url}`);
  
  const options = {
    method: endpoint.method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'API-Diagnostics/1.0',
    },
  };
  
  if (endpoint.body) {
    options.body = JSON.stringify(endpoint.body);
    options.headers['Content-Length'] = Buffer.byteLength(options.body);
  }
  
  try {
    const startTime = Date.now();
    const response = await makeRequest(url, options);
    const duration = Date.now() - startTime;
    
    // Parse response body if JSON
    let parsedBody;
    try {
      parsedBody = JSON.parse(response.body);
    } catch {
      parsedBody = response.body;
    }
    
    // Determine status
    const isSuccess = response.status >= 200 && response.status < 300;
    const statusColor = isSuccess ? colors.green : response.status >= 400 ? colors.red : colors.yellow;
    
    console.log(`${statusColor}Status: ${response.status} ${response.statusMessage}${colors.reset}`);
    console.log(`Response time: ${duration}ms`);
    
    // Show relevant headers
    const relevantHeaders = ['content-type', 'content-length', 'cache-control', 'x-powered-by'];
    console.log('Headers:');
    relevantHeaders.forEach(header => {
      if (response.headers[header]) {
        console.log(`  ${header}: ${response.headers[header]}`);
      }
    });
    
    // Show response preview
    if (typeof parsedBody === 'object') {
      console.log('Response preview:');
      const preview = JSON.stringify(parsedBody, null, 2).split('\n').slice(0, 5).join('\n');
      console.log(colors.cyan + preview + colors.reset);
      if (JSON.stringify(parsedBody).length > 200) {
        console.log('  ... (truncated)');
      }
    } else if (typeof parsedBody === 'string') {
      console.log('Response: ' + parsedBody.substring(0, 100) + (parsedBody.length > 100 ? '...' : ''));
    }
    
    console.log(`${isSuccess ? colors.green + '✅ Success' : colors.red + '❌ Failed'}${colors.reset}\n`);
    
    return {
      endpoint: endpoint.name,
      status: response.status,
      duration,
      success: isSuccess,
    };
  } catch (error) {
    console.log(`${colors.red}❌ Error: ${error.message}${colors.reset}`);
    console.log(`${colors.red}${error.stack}${colors.reset}\n`);
    
    return {
      endpoint: endpoint.name,
      error: error.message,
      success: false,
    };
  }
}

// Test server connectivity
async function testServerConnectivity() {
  console.log(`${colors.bright}Testing Server Connectivity${colors.reset}`);
  
  try {
    const parsedUrl = new URL(baseUrl);
    const startTime = Date.now();
    
    // Try to connect to the base URL
    const response = await makeRequest(baseUrl, { method: 'HEAD' });
    const duration = Date.now() - startTime;
    
    console.log(`${colors.green}✅ Server is reachable${colors.reset}`);
    console.log(`Response time: ${duration}ms`);
    console.log(`Server: ${response.headers.server || 'Unknown'}\n`);
    
    return true;
  } catch (error) {
    console.log(`${colors.red}❌ Cannot reach server${colors.reset}`);
    console.log(`Error: ${error.message}\n`);
    
    if (error.code === 'ECONNREFUSED') {
      console.log(`${colors.yellow}💡 Tip: Make sure the server is running${colors.reset}`);
      console.log(`${colors.yellow}   Run: npm run dev${colors.reset}\n`);
    } else if (error.code === 'ENOTFOUND') {
      console.log(`${colors.yellow}💡 Tip: Check the URL is correct${colors.reset}\n`);
    }
    
    return false;
  }
}

// Main diagnostic function
async function runDiagnostics() {
  console.log('='.repeat(50));
  console.log(`${colors.bright}API DIAGNOSTICS REPORT${colors.reset}`);
  console.log('='.repeat(50) + '\n');
  
  // Test server connectivity first
  const serverReachable = await testServerConnectivity();
  
  if (!serverReachable) {
    console.log(`${colors.red}Cannot proceed with API tests - server unreachable${colors.reset}`);
    process.exit(1);
  }
  
  // Test all endpoints
  const results = [];
  for (const endpoint of endpoints) {
    const result = await testEndpoint(endpoint);
    results.push(result);
  }
  
  // Summary
  console.log('='.repeat(50));
  console.log(`${colors.bright}SUMMARY${colors.reset}`);
  console.log('='.repeat(50) + '\n');
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`Total endpoints tested: ${results.length}`);
  console.log(`${colors.green}Successful: ${successful}${colors.reset}`);
  console.log(`${colors.red}Failed: ${failed}${colors.reset}\n`);
  
  // Show failed endpoints
  if (failed > 0) {
    console.log(`${colors.red}Failed endpoints:${colors.reset}`);
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.endpoint}: ${r.error || `Status ${r.status}`}`);
    });
    console.log();
  }
  
  // Recommendations
  console.log(`${colors.bright}RECOMMENDATIONS${colors.reset}`);
  
  if (failed === 0) {
    console.log(`${colors.green}✅ All API endpoints are working correctly!${colors.reset}`);
  } else {
    console.log(`${colors.yellow}⚠️  Some endpoints are failing. Recommendations:${colors.reset}`);
    
    // Check for auth issues
    const authFailed = results.find(r => r.endpoint === 'Auth Session' && !r.success);
    if (authFailed) {
      console.log('  1. Authentication might not be configured properly');
      console.log('     - Check NEXTAUTH_SECRET is set');
      console.log('     - Check NEXTAUTH_URL matches your base URL');
    }
    
    // Check for 405 errors (method not allowed)
    const methodNotAllowed = results.filter(r => r.status === 405);
    if (methodNotAllowed.length > 0) {
      console.log('  2. Some endpoints don\'t support the HTTP method used');
      console.log('     - Check the API route implementation');
    }
    
    // Check for 404 errors
    const notFound = results.filter(r => r.status === 404);
    if (notFound.length > 0) {
      console.log('  3. Some endpoints were not found');
      console.log('     - Check if the API routes are properly defined');
      console.log('     - Verify the file structure in app/api/');
    }
    
    // Check for 500 errors
    const serverErrors = results.filter(r => r.status >= 500);
    if (serverErrors.length > 0) {
      console.log('  4. Server errors detected');
      console.log('     - Check server logs for detailed error messages');
      console.log('     - Verify database connection and environment variables');
    }
  }
  
  console.log(`\n${colors.cyan}Diagnostics complete!${colors.reset}`);
}

// Run diagnostics
runDiagnostics().catch(error => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  process.exit(1);
});