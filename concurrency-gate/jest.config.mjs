/**
 * concurrency-gate/jest.config.mjs — the concurrency gate's OWN jest project
 * (plan P-2; pack C7a.1).
 *
 * Run via `node scripts/test-runner.js concurrency` (`npm run test:concurrency`).
 * The ROOT jest run ignores `<rootDir>/concurrency-gate/` (jest.config.js) so the
 * container never boots under `all` — the `mcp/` and `launch-gate/` precedent.
 *
 * Deliberately NO `setupFilesAfterEach`/`setupFiles`: the root project's
 * jest.setup.js force-mocks `@/lib/prisma` globally, and this suite's whole
 * purpose is to drive the REAL lib cores against a REAL database over two
 * independent client sessions.
 *
 * ts-jest transpiles to CommonJS with isolatedModules (the launch-gate/mcp
 * precedent) — type-checking is `npx tsc --noEmit`'s job, and concurrency-gate/
 * is inside the root tsconfig's include, so it is strict-checked there.
 *
 * @type {import('jest').Config}
 */
export default {
  displayName: "concurrency",
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
  // Serial by contract: one container, one fixture, one deterministic order. The
  // races inside a scenario are the only concurrency this project wants.
  maxWorkers: 1,
  // Real InnoDB lock waits plus a container boot on the first file.
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
