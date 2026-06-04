/** @jest-environment node */
import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});
import prisma from "@/lib/prisma";
import { getScratchpadBoard, getLabelSuggestions } from "@/lib/scratchpad/queries";

const m = () => prisma as unknown as DeepMockProxy<typeof prisma>;
beforeEach(() => mockReset(m()));

describe("getScratchpadBoard", () => {
  it("filters deletedAt:null + has-rows, does NOT filter approvalStatus, orders by latest edit then id", async () => {
    m().product.findMany.mockResolvedValue([
      { id: 2, scratchpadPrices: [{ updatedAt: new Date("2026-06-01") }] },
      { id: 1, scratchpadPrices: [{ updatedAt: new Date("2026-06-03") }] },
    ] as any);
    const board = await getScratchpadBoard();
    const where = (m().product.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ deletedAt: null, scratchpadPrices: { some: {} } });
    expect(where).not.toHaveProperty("approvalStatus"); // SHOW-contract: mirrors browse
    expect(board.map((p) => p.id)).toEqual([1, 2]); // newest edit first
  });
  it("returns [] when no products have rows", async () => {
    m().product.findMany.mockResolvedValue([] as any);
    expect(await getScratchpadBoard()).toEqual([]);
  });
});

describe("getLabelSuggestions", () => {
  it("queries distinct labels, excludes soft-deleted products", async () => {
    m().productScratchpadPrice.findMany.mockResolvedValue([{ label: "Awake Price" }] as any);
    const labels = await getLabelSuggestions("Aw");
    const where = (m().productScratchpadPrice.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ product: { deletedAt: null }, label: { contains: "Aw" } });
    expect(labels).toEqual(["Awake Price"]);
  });
});
