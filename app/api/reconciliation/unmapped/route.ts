import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAdmin } from '@/lib/api-utils';
import { listUnmapped } from '@/lib/reconciliation/unmapped';

export const dynamic = 'force-dynamic';

/** PLAIN `z.object` (house rule 1): the MCP adapter reads `.shape`. */
const UnmappedQuerySchema = z.object({
  olderThanDays: z.coerce.number().int().min(0).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

/**
 * GET /api/reconciliation/unmapped?olderThanDays&limit&cursor (reconciliation
 * lane, pack C2c.4; spec REV-7 §4.4 / §5).
 *
 * External order lines nobody has mapped yet, GROUPED by the triple a person
 * maps — integration, external product, variant — with the item count, the age
 * of the oldest order still waiting, and the age bands for the whole window.
 *
 * `count` and `buckets` are GLOBAL within the age filter; the groups are
 * page-local, and `moreCount` says how many the page left off. The deep link
 * carries its own warning: following it loads the live store catalog.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const params = request.nextUrl.searchParams;
  const query = UnmappedQuerySchema.parse({
    olderThanDays: params.get('olderThanDays') ?? undefined,
    limit: params.get('limit') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
  });

  const page = await listUnmapped({
    olderThanDays: query.olderThanDays,
    limit: query.limit,
    cursor: query.cursor,
  });

  return NextResponse.json(page);
});
