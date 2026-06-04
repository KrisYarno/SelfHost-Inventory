import prisma from "@/lib/prisma";
import { OptimisticLockError } from "@/lib/inventory";
import { AppError } from "@/lib/error-handling";

async function nextSortOrder(productId: number): Promise<number> {
  const agg = await prisma.productScratchpadPrice.aggregate({
    where: { productId },
    _max: { sortOrder: true },
  });
  return (agg._max.sortOrder ?? -1) + 1;
}

export async function createScratchpadRow(
  input: { productId: number; label: string; value?: string | null; note?: string | null; sortOrder?: number },
  actor: { id: number },
) {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: { id: true },
  });
  if (!product) throw new AppError("Product not found", "BAD_REQUEST", 400);
  const sortOrder = input.sortOrder ?? (await nextSortOrder(input.productId));
  return prisma.productScratchpadPrice.create({
    data: {
      productId: input.productId,
      label: input.label,
      value: input.value ?? null,
      note: input.note ?? null,
      sortOrder,
      version: 0,
      createdBy: actor.id,
      updatedBy: actor.id,
    },
    include: { updatedByUser: { select: { id: true, username: true } } },
  });
}

export async function updateScratchpadRow(
  id: number,
  expectedVersion: number,
  patch: { label?: string; value?: string | null; note?: string | null; sortOrder?: number },
  actor: { id: number },
) {
  const res = await prisma.productScratchpadPrice.updateMany({
    where: { id, version: expectedVersion },
    data: { ...patch, version: { increment: 1 }, updatedBy: actor.id },
  });
  if (res.count === 0) {
    const current = await prisma.productScratchpadPrice.findUnique({ where: { id } });
    if (!current) throw new AppError("Scratchpad row not found", "NOT_FOUND", 404);
    throw new OptimisticLockError("Row was modified by someone else", current.version, expectedVersion);
  }
  // Racey edge: a concurrent delete between the guarded update and this read returns null.
  // Return null; the route maps null -> 200 { deleted: true } (client refetches), never a 500.
  return prisma.productScratchpadPrice.findUnique({
    where: { id },
    include: { updatedByUser: { select: { id: true, username: true } } },
  });
}

export async function deleteScratchpadRow(id: number, expectedVersion: number) {
  const res = await prisma.productScratchpadPrice.deleteMany({ where: { id, version: expectedVersion } });
  if (res.count === 0) {
    const current = await prisma.productScratchpadPrice.findUnique({ where: { id } });
    if (!current) throw new AppError("Scratchpad row not found", "NOT_FOUND", 404);
    throw new OptimisticLockError("Row was modified by someone else", current.version, expectedVersion);
  }
  return { deleted: true };
}
