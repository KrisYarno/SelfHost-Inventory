/** @jest-environment node */
import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});
import prisma from "@/lib/prisma";
import { getScratchpadBoard } from "@/lib/scratchpad/queries";

const m = () => prisma as unknown as DeepMockProxy<typeof prisma>;
beforeEach(() => mockReset(m()));

it("board query mirrors browse SHOW set: deletedAt:null, NO approvalStatus filter", async () => {
  m().product.findMany.mockResolvedValue([] as any);
  await getScratchpadBoard();
  const where = (m().product.findMany.mock.calls[0][0] as any).where;
  expect(where).toMatchObject({ deletedAt: null });
  expect(where).not.toHaveProperty("approvalStatus");
});
