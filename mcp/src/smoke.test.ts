/**
 * mcp/src/smoke.test.ts — the skeleton's smoke test (run via `npm run test:mcp`,
 * the mcp jest project). Proves a shared tool imports + runs under this project,
 * independent of the AI/MCP SDKs (find_product's graph never touches them). T5
 * replaces/extends this with the real sidecar suites (auth/lifecycle/rate/parity).
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },
    product_locations: {
      findMany: jest.fn(async () => []),
    },
    systemSetting: {
      findUnique: jest.fn(async () => null),
    },
  },
}));

import { assistantTools } from "@/lib/assistant/tools";

describe("mcp skeleton: shared tool runs via the @ alias", () => {
  it("find_product executes against a mocked prisma and returns ok", async () => {
    const result = await assistantTools.find_product.run(
      { query: "abc" },
      { userId: 1, isAdmin: false, companyIds: [], surface: "mcp" },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual({ products: [] });
      expect(result.meta.scope).toBe("global");
    }
  });
});
