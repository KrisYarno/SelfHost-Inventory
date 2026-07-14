const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    // Handle module aliases (this will be automatically configured for you soon)
    "^@/(.*)$": "<rootDir>/$1",
  },
  // P1-14: Default to node so server-side API tests behave correctly without
  // each file having to declare `@jest-environment node`. React component tests
  // that need jsdom can opt in per-file with `@jest-environment jsdom`.
  testEnvironment: "jest-environment-node",
  testMatch: ["**/__tests__/**/*.(ts|tsx|js|jsx)", "**/*.(test|spec).(ts|tsx|js|jsx)"],
  // The MCP sidecar (mcp/) is an ESM package with its own jest project
  // (mcp/jest.config.mjs, run via `npm run test:mcp`). Keep it out of the root
  // run so each suite executes exactly once under `test:ci` (plan P-M6).
  testPathIgnorePatterns: [
    "/node_modules/",
    "/.next/",
    "/.claude/",
    "<rootDir>/mcp/",
    // Lane 6: support harness + bypass fixtures are imported BY tests, they are
    // not test suites themselves (jest would otherwise fail them as "no tests").
    "<rootDir>/__tests__/support/",
    "<rootDir>/__tests__/fixtures/",
  ],
  collectCoverageFrom: [
    "app/**/*.{js,jsx,ts,tsx}",
    "components/**/*.{js,jsx,ts,tsx}",
    "hooks/**/*.{js,jsx,ts,tsx}",
    "lib/**/*.{js,jsx,ts,tsx}",
    "!**/*.d.ts",
    "!**/node_modules/**",
    "!**/.next/**",
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig);
