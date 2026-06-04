/** @jest-environment node */
import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});
import prisma from "@/lib/prisma";
import { OptimisticLockError } from "@/lib/inventory";
import { AppError } from "@/lib/error-handling";
import { createScratchpadRow, updateScratchpadRow, deleteScratchpadRow } from "@/lib/scratchpad/mutations";

const m = () => prisma as unknown as DeepMockProxy<typeof prisma>;
beforeEach(() => mockReset(m()));

describe("updateScratchpadRow", () => {
  it("succeeds and returns the new row when version matches", async () => {
    m().productScratchpadPrice.updateMany.mockResolvedValue({ count: 1 } as any);
    m().productScratchpadPrice.findUnique.mockResolvedValue({ id: 5, version: 3, label: "x" } as any);
    const row = await updateScratchpadRow(5, 2, { value: "42" }, { id: 9 });
    expect(row!.version).toBe(3);
    expect(m().productScratchpadPrice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5, version: 2 } }),
    );
  });
  it("throws OptimisticLockError when count === 0 and row still exists (stale version)", async () => {
    m().productScratchpadPrice.updateMany.mockResolvedValue({ count: 0 } as any);
    m().productScratchpadPrice.findUnique.mockResolvedValue({ id: 5, version: 7 } as any);
    await expect(updateScratchpadRow(5, 2, { value: "42" }, { id: 9 })).rejects.toBeInstanceOf(OptimisticLockError);
  });
  it("throws 404 AppError when count === 0 and row is gone", async () => {
    m().productScratchpadPrice.updateMany.mockResolvedValue({ count: 0 } as any);
    m().productScratchpadPrice.findUnique.mockResolvedValue(null as any);
    await expect(updateScratchpadRow(5, 2, { value: "42" }, { id: 9 })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("returns null gracefully when a concurrent delete races the post-write read", async () => {
    m().productScratchpadPrice.updateMany.mockResolvedValue({ count: 1 } as any);
    m().productScratchpadPrice.findUnique.mockResolvedValue(null as any);
    await expect(updateScratchpadRow(5, 2, { value: "42" }, { id: 9 })).resolves.toBeNull();
  });
});

describe("createScratchpadRow", () => {
  it("rejects a soft-deleted/missing product with 400", async () => {
    m().product.findFirst.mockResolvedValue(null as any);
    await expect(createScratchpadRow({ productId: 1, label: "x" }, { id: 9 })).rejects.toMatchObject({ statusCode: 400 });
  });
  it("sets createdBy/updatedBy and computed sortOrder", async () => {
    m().product.findFirst.mockResolvedValue({ id: 1 } as any);
    m().productScratchpadPrice.aggregate.mockResolvedValue({ _max: { sortOrder: 2 } } as any);
    m().productScratchpadPrice.create.mockResolvedValue({ id: 10, sortOrder: 3 } as any);
    await createScratchpadRow({ productId: 1, label: "x" }, { id: 9 });
    expect(m().productScratchpadPrice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdBy: 9, updatedBy: 9, sortOrder: 3 }) }),
    );
  });
});

describe("deleteScratchpadRow", () => {
  it("throws OptimisticLockError on stale version", async () => {
    m().productScratchpadPrice.deleteMany.mockResolvedValue({ count: 0 } as any);
    m().productScratchpadPrice.findUnique.mockResolvedValue({ id: 5, version: 4 } as any);
    await expect(deleteScratchpadRow(5, 1)).rejects.toBeInstanceOf(OptimisticLockError);
  });
});
