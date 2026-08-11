#!/usr/bin/env node

const { spawn } = require('child_process');
// `fs`/`os` back the launch gate's per-run state file (below). Disabled per line so
// this CJS script's existing lint profile is unchanged by the addition.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os');
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
    pattern: '__tests__/unit/**/*.test.{ts,tsx,js,jsx}',
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
  gate: {
    name: 'Gate Suite',
    // The registration point every contract-gate test file appends to. Multi-pattern
    // (`patterns`) instead of the single `pattern` the other suites use.
    patterns: [
      '__tests__/unit/lib/assistant/toolsuite-gates.test.ts',
      '__tests__/unit/lib/reports/metrics-contract.test.ts',
      '__tests__/unit/lib/assistant/prompt-rules.test.ts',
      '__tests__/unit/lib/assistant/tool-presentation.test.ts',
      '__tests__/unit/lib/reports/reorder-coverage-invariant.test.ts',
      '__tests__/unit/lib/reports/outbound-mix.test.ts',
      '__tests__/unit/lib/assistant/lifecycle-visibility.test.ts',
    ],
    description: 'Fast named subset of the contract gates (also covered by "all")',
  },
  launch: {
    name: 'Launch Gate',
    // The DB-backed structured-layer harness (multiuser spec C7): its own jest
    // project, its own globalSetup/globalTeardown, NO positional pattern — that
    // config's testMatch decides what runs. Fails closed with an actionable message
    // when Docker or the 3100-3102 ports are unavailable.
    config: 'launch-gate/jest.config.mjs',
    description: 'DB-backed launch gate (throwaway container + app/mcp/shim over HTTP)',
  },
  all: {
    name: 'All Tests',
    pattern: '__tests__/**/*.test.{ts,tsx,js,jsx}',
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

// Build jest command. A suite declares EITHER one `pattern` or a `patterns` list;
// every pattern is spliced in where the single positional pattern used to go. A suite
// MAY also name its own `config` (the launch gate is a separate jest project) — and a
// config-bearing suite may declare NO pattern at all, in which case jest receives no
// positional filter and that config's own testMatch decides what runs. The splice is
// guarded: an absent pattern must never reach argv as the string "undefined".
const suiteDef = testSuites[suite];
const patterns = suiteDef.patterns ?? (suiteDef.pattern ? [suiteDef.pattern] : []);
const configPath = suiteDef.config ?? 'jest.config.js';
const jestArgs = [
  'jest',
  ...patterns,
  '--config', configPath,
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
console.log(`${colors.yellow}📁 Pattern: ${patterns.length > 0 ? patterns.join(', ') : `(none — ${configPath} testMatch)`}${colors.reset}`);
if (watch) console.log(`${colors.yellow}👀 Watch mode enabled${colors.reset}`);
if (coverage) console.log(`${colors.yellow}📊 Coverage report enabled${colors.reset}`);
console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

// The launch gate's cross-process state file (multiuser contract pack CP-7): jest's
// globalSetup state never reaches a test suite's module registry, so the harness and
// its suites share a mode-0600 JSON document instead. The path must exist BEFORE jest
// starts and must be unique per run — two concurrent runs sharing one path would
// corrupt each other's pids and session cookies.
const launchGateFiles = [];
function createLaunchGateStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-gate-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '', { mode: 0o600 });
  launchGateFiles.push(dir);
  return file;
}

function cleanupLaunchGateFiles() {
  for (const target of launchGateFiles) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* best effort — the harness's own teardown owns the real resources */
    }
  }
}

const jestEnv = { ...process.env, NODE_ENV: 'test' };
if (suite === 'launch') {
  jestEnv.LAUNCH_GATE_STATE_FILE = createLaunchGateStateFile();
}

// Run jest
const jest = spawn('npx', jestArgs, {
  stdio: 'inherit',
  shell: true,
  env: jestEnv
});

// Handle exit
jest.on('close', (code) => {
  cleanupLaunchGateFiles();
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
  cleanupLaunchGateFiles();
  console.error(`${colors.red}Failed to start test runner:${colors.reset}`, error);
  process.exit(1);
});