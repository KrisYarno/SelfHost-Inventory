import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import { LabelingQueueQuerySchema } from '@/lib/validation/supply-orders';
import { listLabelingQueue } from '@/lib/supply-orders/queries';

export const dynamic = 'force-dynamic';

/**
 * GET /api/labeling/queue?orderId= — THE LABELING WORK LIST (spec §4.3.1).
 *
 * Every supply-order line with units still to stock, oldest verify first,
 * grouped by the order it arrived on. `?orderId=` narrows it to one order — the
 * "Label now" link from the order detail, which is what lets one person walk a
 * delivery from the dock to the shelf without re-finding it.
 *
 * A PURE READ: the query parse and the envelope are all this handler owns, the
 * shape belongs to `lib/supply-orders/queries.ts`, and nothing here causes a
 * side effect — so it takes no `GET_SIDE_EFFECT_REGISTRY` entry.
 *
 * `moreCount` is TRUTHFUL rather than decorative: the bound is applied in SQL
 * after the filter, and the COUNT runs in the same read transaction, so "N more"
 * cannot contradict the rows above it.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const query = LabelingQueueQuerySchema.parse({
    orderId: request.nextUrl.searchParams.get('orderId') ?? undefined,
  });

  const queue = await listLabelingQueue({ orderId: query.orderId });

  return NextResponse.json(queue);
});
