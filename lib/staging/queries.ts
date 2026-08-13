import prisma from '@/lib/prisma';
import type { StagingItemStatus } from '@prisma/client';

/**
 * Read helpers for the pre-staging intake queue.
 *
 * Both list and single-get hydrate the same relations so the queue UI and the
 * detail/edit views render off one shape:
 *   - location:        the bin/location the box was received into
 *   - resolvedProduct: the product a GRADUATED item was turned into (null until then)
 *   - receivedByUser:  who logged the box — ID AND USERNAME ONLY
 *
 * SECURITY (W1-3b ride-along B): `receivedByUser` was `true`, i.e. every column
 * of the User row — passwordHash included — and both helpers below return their
 * rows VERBATIM to the client. The queue only ever rendered a username. Same
 * rule as `createInventoryLog`'s include: name the fields, never hand back a
 * whole User. Pinned by
 * __tests__/integration/api/staging-items-password-hash.test.ts (a deep scan of
 * the response, not a shape check).
 */
const stagingInclude = {
  location: true,
  resolvedProduct: true,
  receivedByUser: { select: { id: true, username: true } },
} as const;

/**
 * List staging items filtered by status, newest-received first.
 */
export async function listStagingItems(status: StagingItemStatus) {
  return prisma.stagingItem.findMany({
    where: { status },
    include: stagingInclude,
    orderBy: { receivedAt: 'desc' },
  });
}

/**
 * Fetch a single staging item by id with the same hydrated relations, or null
 * if it does not exist.
 */
export async function getStagingItem(id: number) {
  return prisma.stagingItem.findUnique({
    where: { id },
    include: stagingInclude,
  });
}
