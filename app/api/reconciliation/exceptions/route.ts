import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAdmin } from '@/lib/api-utils';
import { EXCEPTION_KINDS } from '@/lib/exceptions/kinds';
import { listExceptions } from '@/lib/reconciliation/exceptions';

export const dynamic = 'force-dynamic';

/**
 * PLAIN `z.object` (house rule 1): no `.refine` at the object level, because
 * the MCP adapter reads `.shape` off request schemas.
 *
 * The three vocabularies are CLOSED and checked here rather than in the
 * producer: a typo in a filter is a 400 with the allowed values in it, not an
 * empty page that reads as "nothing to do". `severity`'s three literals are
 * spelled here and checked against `ExceptionSeverity` at the call site below,
 * so a fourth level cannot be added in one place only.
 */
const ExceptionsQuerySchema = z.object({
  kind: z.enum(EXCEPTION_KINDS).optional(),
  resolved: z.enum(['open', 'resolved', 'all']).optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  olderThanDays: z.coerce.number().int().min(0).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

/**
 * GET /api/reconciliation/exceptions?kind&resolved&severity&olderThanDays&limit&cursor
 * (reconciliation lane, pack C2c.4; spec REV-7 §4.3 / §5).
 *
 * The FINDER half of the register (SETTLED 10): filter, age, and a deep link to
 * the surface that already resolves each kind. Part 1 writes nothing here — the
 * Resolve controls live on the receiving and product-review pages, and this tab
 * is how somebody finds the right one.
 *
 * Defaults to the OPEN half, which is the half somebody still has to do
 * something about; `resolved=all` is how you look at history.
 *
 * ADMIN-ONLY: exception rows carry an admin's own free-text note, and this is
 * the app's admin bypass — no membership scoping on this surface.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const params = request.nextUrl.searchParams;
  const query = ExceptionsQuerySchema.parse({
    kind: params.get('kind') ?? undefined,
    resolved: params.get('resolved') ?? undefined,
    severity: params.get('severity') ?? undefined,
    olderThanDays: params.get('olderThanDays') ?? undefined,
    limit: params.get('limit') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
  });

  const page = await listExceptions({
    kind: query.kind,
    resolved: query.resolved,
    severity: query.severity,
    olderThanDays: query.olderThanDays,
    limit: query.limit,
    cursor: query.cursor,
  });

  return NextResponse.json(page);
});
