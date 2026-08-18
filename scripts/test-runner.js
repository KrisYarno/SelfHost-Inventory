#!/usr/bin/env node

const { spawn } = require('child_process');
// `fs`/`os` back the DB-backed gates' per-run state files (below). Disabled per line so
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
  // The DB-backed structured-layer harness (multiuser spec C7): its own jest project,
  // its own globalSetup/globalTeardown, NO positional pattern — that config's testMatch
  // decides what runs. Fails closed with an actionable message when Docker or the
  // 3100-3102 ports are unavailable.
  //
  // TWO PROFILES from W3 (plan Task 3.3): the same matrix against `next dev` and
  // against the PRODUCTION artifact (`next build` once, then `next start`). Each leg is
  // its own jest process with its own state file and its own throwaway container, so
  // they share nothing but the repo.
  'launch:dev': {
    name: 'Launch Gate (dev profile)',
    config: 'launch-gate/jest.config.mjs',
    stateEnv: 'LAUNCH_GATE_STATE_FILE',
    statePrefix: 'launch-gate-',
    profile: 'dev',
    description: 'launch gate against `next dev` (the W1/W2 path)',
  },
  'launch:start': {
    name: 'Launch Gate (start profile)',
    config: 'launch-gate/jest.config.mjs',
    stateEnv: 'LAUNCH_GATE_STATE_FILE',
    statePrefix: 'launch-gate-',
    profile: 'start',
    description: 'launch gate against the built artifact (`next build` + `next start`)',
  },
  launch: {
    name: 'Launch Gate (both profiles)',
    // AGGREGATE (plan Task 3.3): `launch` is the gate-blocking name the wave-close
    // ritual runs, and from W3 it means BOTH profiles, in order, with both counts
    // reported. Legs run even after a failure — a wave close wants to know whether the
    // production artifact fails the same way `next dev` did, not just that something did.
    aggregates: ['launch:dev', 'launch:start'],
    description: 'DB-backed launch gate — dev profile then start profile (both must pass)',
  },
  // The real-DB CONCURRENCY gate (overhaul plan P-2): its own jest project, its own
  // globalSetup/globalTeardown, NO positional pattern — that config's testMatch decides
  // what runs. Boots a throwaway mysql:8.4 container and drives the lib cores directly
  // over two independent PrismaClient sessions; no app, no ports, no checksum bracket
  // (business writes are the POINT here, which is exactly why it is not the launch gate).
  concurrency: {
    name: 'Concurrency Gate',
    config: 'concurrency-gate/jest.config.mjs',
    stateEnv: 'CONCURRENCY_GATE_STATE_FILE',
    statePrefix: 'concurrency-gate-',
    description:
      'real-DB concurrency proofs for the supply-order primitive (throwaway mysql:8.4; lib cores driven directly)',
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

// Add any additional arguments passed to the script
const additionalArgs = args.filter(arg =>
  arg !== suite &&
  !['--watch', '-w', '--coverage', '-c', '--verbose', '-v'].includes(arg)
);

// A GATE's cross-process state file (multiuser contract pack CP-7; overhaul pack
// C7a.1): jest's globalSetup state never reaches a test suite's module registry, so a
// DB-backed harness and its suites share a mode-0600 JSON document instead. The path
// must exist BEFORE jest starts and must be unique per run — two concurrent runs (or
// two aggregated profile legs) sharing one path would corrupt each other's state.
//
// GENERALIZED over the prefix (overhaul pack C7a.1): the launch gate and the
// concurrency gate each mint their own file under their own env var, and the runner
// owns the recursive cleanup of both.
const gateStateDirs = [];
function createGateStateFile(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '', { mode: 0o600 });
  gateStateDirs.push(dir);
  return file;
}

function cleanupGateStateFiles() {
  for (const target of gateStateDirs) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* best effort — the harness's own teardown owns the real resources */
    }
  }
}

// Build + run ONE leg. A suite declares EITHER one `pattern` or a `patterns` list;
// every pattern is spliced in where the single positional pattern used to go. A suite
// MAY also name its own `config` (the launch gate is a separate jest project) — and a
// config-bearing suite may declare NO pattern at all, in which case jest receives no
// positional filter and that config's own testMatch decides what runs. The splice is
// guarded: an absent pattern must never reach argv as the string "undefined".
function runLeg(key) {
  const def = testSuites[key];
  const patterns = def.patterns ?? (def.pattern ? [def.pattern] : []);
  const configPath = def.config ?? 'jest.config.js';
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

  jestArgs.push(...additionalArgs);

  // Print test run information
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.cyan}🧪 Running ${def.name}${colors.reset}`);
  console.log(`${colors.yellow}📁 Pattern: ${patterns.length > 0 ? patterns.join(', ') : `(none — ${configPath} testMatch)`}${colors.reset}`);
  if (def.profile) console.log(`${colors.yellow}🏗  Launch profile: ${def.profile}${colors.reset}`);
  if (watch) console.log(`${colors.yellow}👀 Watch mode enabled${colors.reset}`);
  if (coverage) console.log(`${colors.yellow}📊 Coverage report enabled${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  const jestEnv = { ...process.env, NODE_ENV: 'test' };
  // A state file is minted for EVERY config-bearing leg that declares one; the run
  // profile is the launch gate's alone and controls only LAUNCH_GATE_PROFILE.
  if (def.stateEnv) {
    jestEnv[def.stateEnv] = createGateStateFile(def.statePrefix);
  }
  if (def.profile) {
    jestEnv.LAUNCH_GATE_PROFILE = def.profile;
  }

  return new Promise((resolve) => {
    const jest = spawn('npx', jestArgs, {
      stdio: 'inherit',
      shell: true,
      env: jestEnv
    });
    jest.on('close', (code) => resolve(code === null ? 1 : code));
    jest.on('error', (error) => {
      console.error(`${colors.red}Failed to start test runner:${colors.reset}`, error);
      resolve(1);
    });
  });
}

// A suite either IS a leg or aggregates several. Every leg runs, even after a failing
// one: when the launch gate is red, "does the production artifact fail the same way?"
// is the next question, and paying for a second run to answer it is worse.
const legs = testSuites[suite].aggregates ?? [suite];

(async () => {
  const results = [];
  for (const key of legs) {
    results.push({ key, code: await runLeg(key) });
  }
  cleanupGateStateFiles();

  const failed = results.filter((result) => result.code !== 0);
  if (results.length > 1) {
    console.log(`\n${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    for (const result of results) {
      const mark = result.code === 0 ? `${colors.green}PASS${colors.reset}` : `${colors.red}FAIL (${result.code})${colors.reset}`;
      console.log(`  ${mark}  ${testSuites[result.key].name}`);
    }
    console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  }

  if (failed.length === 0) {
    console.log(`\n${colors.green}✅ Tests completed successfully!${colors.reset}`);
  } else {
    console.log(`\n${colors.red}❌ Tests failed with exit code ${failed[0].code}${colors.reset}`);
  }

  if (coverage) {
    console.log(`\n${colors.cyan}📊 Coverage report generated:${colors.reset}`);
    console.log(`   HTML: ${path.join(process.cwd(), 'coverage/lcov-report/index.html')}`);
    console.log(`   LCOV: ${path.join(process.cwd(), 'coverage/lcov.info')}`);
  }

  process.exit(failed.length === 0 ? 0 : failed[0].code);
})();