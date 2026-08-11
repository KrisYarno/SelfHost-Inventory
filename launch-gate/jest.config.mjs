/**
 * launch-gate/jest.config.mjs — the launch gate's OWN jest project (spec C7).
 *
 * Run via `node scripts/test-runner.js launch` (`npm run test:launch`). The ROOT
 * jest run ignores `<rootDir>/launch-gate/` (jest.config.js:31) so the container
 * never boots under `all` — the `mcp/` precedent.
 *
 * Deliberately NO `setupFilesAfterEach`/`setupFiles`: the root project's
 * jest.setup.js force-mocks `@/lib/prisma` globally, and this suite's whole purpose
 * is to drive REAL processes against a REAL database over HTTP.
 *
 * ts-jest transpiles to CommonJS with isolatedModules (the mcp/jest.config.mjs
 * precedent) — type-checking is `npx tsc --noEmit`'s job, and launch-gate/ is inside
 * the root tsconfig's include, so it is strict-checked there.
 *
 * @type {import('jest').Config}
 */
export default {
  displayName: "launch",
  rootDir: ".",
  roots: ["<rootDir>"],
  testEnvironment: "node",
  testMatch: ["<rootDir>/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json", "node"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/../$1",
  },
  globalSetup: "<rootDir>/global-setup.ts",
  globalTeardown: "<rootDir>/global-teardown.ts",
  // Serial by contract: one container, one app, one shim, one deterministic order.
  maxWorkers: 1,
  // HTTP round-trips against `next dev` plus the ~75s PROVIDER_TIMEOUT cases (1.8).
  // Individual tests may narrow this.
  testTimeout: 120_000,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "Node",
          target: "ES2022",
          esModuleInterop: true,
          allowJs: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          strict: false,
          isolatedModules: true,
        },
      },
    ],
  },
};
