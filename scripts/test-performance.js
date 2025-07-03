#!/usr/bin/env node

/**
 * Performance Testing Script
 * Run with: node scripts/test-performance.js
 */

const https = require('https');
const http = require('http');

// Configuration
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // Set this to a valid session token

// Test scenarios
const tests = [
  {
    name: 'Get Current Inventory (Original)',
    endpoint: '/api/inventory/current',
    method: 'GET',
  },
  {
    name: 'Get Current Inventory (Optimized)',
    endpoint: '/api/inventory/current-optimized',
    method: 'GET',
  },
  {
    name: 'Get Products List',
    endpoint: '/api/products?page=1&pageSize=50',
    method: 'GET',
  },
  {
    name: 'Get Inventory Logs',
    endpoint: '/api/inventory/logs?page=1&pageSize=50',
    method: 'GET',
  },
  {
    name: 'Get Low Stock Report',
    endpoint: '/api/reports/low-stock',
    method: 'GET',
  },
  {
    name: 'Get Metrics Report',
    endpoint: '/api/reports/metrics',
    method: 'GET',
  },
];

// Performance test runner
async function runTest(test, iterations = 5) {
  console.log(`\nTesting: ${test.name}`);
  console.log(`Endpoint: ${test.endpoint}`);
  console.log(`Iterations: ${iterations}`);
  
  const times = [];
  
  for (let i = 0; i < iterations; i++) {
    const startTime = Date.now();
    
    try {
      await makeRequest(test.endpoint, test.method);
      const duration = Date.now() - startTime;
      times.push(duration);
      process.stdout.write('.');
    } catch (error) {
      console.error(`\nError in iteration ${i + 1}:`, error.message);
    }
  }
  
  console.log('\n');
  
  // Calculate statistics
  if (times.length > 0) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    
    console.log(`Results:`);
    console.log(`  Average: ${avg.toFixed(2)}ms`);
    console.log(`  Median: ${median}ms`);
    console.log(`  Min: ${min}ms`);
    console.log(`  Max: ${max}ms`);
    console.log(`  All times: ${times.join(', ')}ms`);
  }
  
  return times;
}

// HTTP request helper
function makeRequest(endpoint, method = 'GET') {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + endpoint);
    const protocol = url.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Cookie': `next-auth.session-token=${AUTH_TOKEN}`,
        'Accept': 'application/json',
      },
    };
    
    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

// Comparison test
async function comparePerformance() {
  console.log('Performance Comparison Test');
  console.log('==========================');
  
  // Run original implementation
  const originalTimes = await runTest({
    name: 'Original Implementation',
    endpoint: '/api/inventory/current?locationId=1',
    method: 'GET',
  }, 10);
  
  // Run optimized implementation
  const optimizedTimes = await runTest({
    name: 'Optimized Implementation',
    endpoint: '/api/inventory/current-optimized?locationId=1',
    method: 'GET',
  }, 10);
  
  // Calculate improvement
  if (originalTimes.length > 0 && optimizedTimes.length > 0) {
    const avgOriginal = originalTimes.reduce((a, b) => a + b, 0) / originalTimes.length;
    const avgOptimized = optimizedTimes.reduce((a, b) => a + b, 0) / optimizedTimes.length;
    const improvement = ((avgOriginal - avgOptimized) / avgOriginal) * 100;
    
    console.log('\nPerformance Improvement:');
    console.log(`  Original avg: ${avgOriginal.toFixed(2)}ms`);
    console.log(`  Optimized avg: ${avgOptimized.toFixed(2)}ms`);
    console.log(`  Improvement: ${improvement.toFixed(1)}%`);
    console.log(`  Speed increase: ${(avgOriginal / avgOptimized).toFixed(1)}x faster`);
  }
}

// Load test
async function loadTest(endpoint, concurrency = 10, duration = 10000) {
  console.log(`\nLoad Test: ${endpoint}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Duration: ${duration}ms`);
  
  const startTime = Date.now();
  let requestCount = 0;
  let errorCount = 0;
  const responseTimes = [];
  
  const workers = Array(concurrency).fill(0).map(async () => {
    while (Date.now() - startTime < duration) {
      const requestStart = Date.now();
      try {
        await makeRequest(endpoint, 'GET');
        responseTimes.push(Date.now() - requestStart);
        requestCount++;
      } catch (error) {
        errorCount++;
      }
    }
  });
  
  await Promise.all(workers);
  
  const elapsed = Date.now() - startTime;
  const rps = (requestCount / elapsed) * 1000;
  const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  
  console.log(`\nResults:`);
  console.log(`  Total requests: ${requestCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log(`  Requests/second: ${rps.toFixed(2)}`);
  console.log(`  Avg response time: ${avgResponseTime.toFixed(2)}ms`);
  console.log(`  Success rate: ${((requestCount - errorCount) / requestCount * 100).toFixed(1)}%`);
}

// Main execution
async function main() {
  console.log('Starting Performance Tests...\n');
  
  if (!AUTH_TOKEN) {
    console.warn('WARNING: No AUTH_TOKEN provided. Tests may fail with 401 errors.');
    console.warn('Set AUTH_TOKEN environment variable with a valid session token.\n');
  }
  
  try {
    // Run individual endpoint tests
    for (const test of tests) {
      await runTest(test, 5);
    }
    
    // Run comparison test
    await comparePerformance();
    
    // Run load test on critical endpoint
    await loadTest('/api/inventory/current-optimized', 5, 5000);
    
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run tests
main();