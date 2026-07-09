import prisma from "@/lib/prisma";
import { OptimisticLockError } from "@/lib/inventory";
import { AppError } from "@/lib/error-handling";
import type { Prisma } from "@prisma/client";

/**
 * Every mutation accepts an optional `tx` (change-tracking Task 10). When the
 * caller runs the version-CAS write and its recordChange in ONE transaction, it
 * threads that `tx` through so the guarded write and the audit event share the
 * same atomic scope — a stale-version 409 (count === 0) records nothing. When
 * omitted, `db` falls back to the singleton client (behavior unchanged).
 */
type ScratchpadDb = typeof prisma | Prisma.TransactionClient;

async function nextSortOrder(productId: number, db: ScratchpadDb): Promise<number> {
  const agg = await db.productScratchpadPrice.aggregate({
    where: { productId },
    _max: { sortOrder: true },
  });
  return (agg._max.sortOrder ?? -1) + 1;
}

export async function createScratchpadRow(
  input: { productId: number; label: string; value?: string | null; note?: string | null; sortOrder?: number },
  actor: { id: number },
  tx?: Prisma.TransactionClient,
) {
  const db: ScratchpadDb = tx ?? prisma;
  const product = await db.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: { id: true },
  });
  if (!product) throw new AppError("Product not found", "BAD_REQUEST", 400);
  const sortOrder = input.sortOrder ?? (await nextSortOrder(input.productId, db));
  return db.productScratchpadPrice.create({
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
  tx?: Prisma.TransactionClient,
) {
  const db: ScratchpadDb = tx ?? prisma;
  const res = await db.productScratchpadPrice.updateMany({
    where: { id, version: expectedVersion },
    data: { ...patch, version: { increment: 1 }, updatedBy: actor.id },
  });
  if (res.count === 0) {
    const current = await db.productScratchpadPrice.findUnique({ where: { id } });
    if (!current) throw new AppError("Scratchpad row not found", "NOT_FOUND", 404);
    throw new OptimisticLockError("Row was modified by someone else", current.version, expectedVersion);
  }
  // Racey edge: a concurrent delete between the guarded update and this read returns null.
  // Return null; the route maps null -> 200 { deleted: true } (client refetches), never a 500.
  return db.productScratchpadPrice.findUnique({
    where: { id },
    include: { updatedByUser: { select: { id: true, username: true } } },
  });
}

export async function deleteScratchpadRow(id: number, expectedVersion: number, tx?: Prisma.TransactionClient) {
  const db: ScratchpadDb = tx ?? prisma;
  const res = await db.productScratchpadPrice.deleteMany({ where: { id, version: expectedVersion } });
  if (res.count === 0) {
    const current = await db.productScratchpadPrice.findUnique({ where: { id } });
    if (!current) throw new AppError("Scratchpad row not found", "NOT_FOUND", 404);
    throw new OptimisticLockError("Row was modified by someone else", current.version, expectedVersion);
  }
  return { deleted: true };
}
