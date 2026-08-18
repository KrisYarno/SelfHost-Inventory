import { NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import { listLegacyLines } from '@/lib/supply-orders/queries';

export const dynamic = 'force-dynamic';

/**
 * GET /api/receiving/legacy-lines — THE PRE-STAGING ARCHIVE (spec §4.3.6 / D8).
 *
 * Read-only history: the graduated and discarded boxes of the flow this lane
 * replaces. It exists because the rows do — a receipt somebody is asked about
 * next year has to be findable — and for no other reason: there is no mutation
 * here, and there never will be.
 *
 * The list takes NO parameters. It is a bounded page of the newest rows
 * (`LEGACY_LINE_LIMIT`, ordered by `receivedAt` descending), and an archive that
 * only grows backwards does not need a filter to stay useful.
 *
 * A PURE READ, like the queue: no CSRF, no rate limiter, no audit, and no
 * `GET_SIDE_EFFECT_REGISTRY` entry, because nothing here causes one.
 */
export const GET = apiHandler(async () => {
  await requireApproved();

  const lines = await listLegacyLines({});

  return NextResponse.json({ lines });
});
