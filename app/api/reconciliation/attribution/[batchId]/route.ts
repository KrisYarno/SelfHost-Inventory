import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, requireAdmin } from '@/lib/api-utils';
import { getBatchDetail } from '@/lib/reconciliation/attribution';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    batchId: string;
  };
}

/**
 * GET /api/reconciliation/attribution/[batchId] — the drill-down (pack C2a.5;
 * spec REV-7 §4.2 / §5).
 *
 * The batch's ledger rows, the audit event that wrote them (labelled: it carries
 * the operator's own free text), every attempt ever recorded against it, the
 * manual attributions, and the derivation when that is what classified it.
 *
 * 404 `{ error: 'unknown batch', code: 'NOT_FOUND' }` when the id names no
 * POPULATION rows — a batch of transfers or counts is not "hidden", it is simply
 * not something this report speaks about, and the same answer covers a batch id
 * that never existed.
 *
 * READ-ONLY at M2a: the manual attribution's POST lands on this same file in the
 * milestone that owns the write path (spec D4), together with its rate limit,
 * its CSRF check and its allow-list entry.
 */
export const GET = apiHandler(async (_request: NextRequest, { params }: RouteParams) => {
  await requireAdmin();

  const detail = await getBatchDetail(params.batchId, { kind: 'admin' });
  if (!detail) {
    return NextResponse.json({ error: 'unknown batch', code: 'NOT_FOUND' }, { status: 404 });
  }

  return NextResponse.json(detail);
});
