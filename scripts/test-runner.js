#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// Color codes for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Test suites configuration
const testSuites = {
  unit: {
    name: 'Unit Tests',
    pattern: '__tests__/unit/**/*.test.{ts,tsx}',
    description: 'Testing individual functions and hooks'
  },
  integration: {
    name: 'Integration Tests',
    pattern: '__tests__/integration/**/*.test.{ts,tsx}',
    description: 'Testing API endpoints and service integration'
  },
  components: {
    name: 'Component Tests',
    pattern: '__tests__/components/**/*.test.{tsx}',
    description: 'Testing React components'
  },
  e2e: {
    name: 'End-to-End Tests',
    pattern: '__tests__/e2e/**/*.test.{tsx}',
    description: 'Testing complete user workflows'
  },
  all: {
    name: 'All Tests',
    pattern: '__tests__/**/*.test.{ts,tsx}',
    description: 'Running all test suites'
  }
};

// Parse command line arguments
const args = process.argv.slice(2);
const suite = args[0] || 'all';
const watch = args.includes('--watch') || args.includes('-w');
const coverage = args.includes('--coverage') || args.includes('-c');
const verbose = args.includes('--verbose') || args.includes('-v');

// Validate suite selection
if (!testSuites[suite]) {
  console.error(`${colors.red}Invalid test suite: ${suite}${colors.reset}`);
  console.log('\nAvailable suites:');
  Object.entries(testSuites).forEach(([key, config]) => {
    console.log(`  ${colors.cyan}${key}${colors.reset} - ${config.description}`);
  });
  process.exit(1);
}

// Build jest command
const jestArgs = [
  'jest',
  testSuites[suite].pattern,
  '--config', 'jest.config.js',
];

if (watch) {
  jestArgs.push('--watch');
}

if (coverage) {
  jestArgs.push('--coverage');
  jestArgs.push('--coverageReporters=text');
  jestArgs.push('--coverageReporters=lcov');
  jestArgs.push('--coverageReporters=html');
}

if (verbose) {
  jestArgs.push('--verbose');
}

// Add any additional arguments passed to the script
const additionalArgs = args.filter(arg => 
  arg !== suite && 
  !['--watch', '-w', '--coverage', '-c', '--verbose', '-v'].includes(arg)
);
jestArgs.push(...additionalArgs);

// Print test run information
console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log(`${colors.cyan}🧪 Running ${testSuites[suite].name}${colors.reset}`);
console.log(`${colors.yellow}📁 Pattern: ${testSuites[suite].pattern}${colors.reset}`);
if (watch) console.log(`${colors.yellow}👀 Watch mode enabled${colors.reset}`);
if (coverage) console.log(`${colors.yellow}📊 Coverage report enabled${colors.reset}`);
console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

// Run jest
const jest = spawn('npx', jestArgs, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NODE_ENV: 'test' }
});

// Handle exit
jest.on('close', (code) => {
  if (code === 0) {
    console.log(`\n${colors.green}✅ Tests completed successfully!${colors.reset}`);
  } else {
    console.log(`\n${colors.red}❌ Tests failed with exit code ${code}${colors.reset}`);
  }
  
  if (coverage) {
    console.log(`\n${colors.cyan}📊 Coverage report generated:${colors.reset}`);
    console.log(`   HTML: ${path.join(process.cwd(), 'coverage/lcov-report/index.html')}`);
    console.log(`   LCOV: ${path.join(process.cwd(), 'coverage/lcov.info')}`);
  }
  
  process.exit(code);
});

// Handle errors
jest.on('error', (error) => {
  console.error(`${colors.red}Failed to start test runner:${colors.reset}`, error);
  process.exit(1);
});