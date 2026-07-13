/**
 * mcp/jest.config.mjs — the MCP package's own jest project (plan P-M6). Run via
 * `npm run test:mcp` (`jest -c mcp/jest.config.mjs`). The root jest run ignores
 * `<rootDir>/mcp/`, so each suite executes exactly once under `test:ci`.
 *
 * ts-jest transpiles to CommonJS with isolatedModules so a single shared-tool test
 * runs fast without type-checking the whole app graph.
 *
 * @type {import('jest').Config}
 */
export default {
  displayName: "mcp",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json", "node"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/../$1",
  },
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
