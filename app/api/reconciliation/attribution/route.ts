import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAdmin } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import {
  ATTRIBUTION_CLASS_KEYS,
  getAttributionReport,
} from '@/lib/reconciliation/attribution';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

/** D7's span cap: the whole read is bounded by the window, so the window is. */
const MAX_SPAN_DAYS = 366;

/** A calendar day, checked LEXICALLY here and for reality below (house rule). */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'from and to must be ISO calendar days (YYYY-MM-DD)');

/**
 * PLAIN `z.object` (house rule 1): no `.refine` at the object level, because the
 * MCP adapter reads `.shape` off request schemas. Cross-field rules live in the
 * assertion below and surface as ordinary 400s.
 */
const AttributionReportQuerySchema = z.object({
  from: calendarDay,
  to: calendarDay,
  class: z.enum(ATTRIBUTION_CLASS_KEYS).optional(),
  orderNumber: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

/** `new Date('2026-02-30')` rolls over to March — a shape check is not enough. */
function assertRealDay(day: string, field: string): void {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new AppError(`${field} is not a real calendar day`, 'VALIDATION_ERROR', 400);
  }
}

function assertWindow(from: string, to: string): void {
  assertRealDay(from, 'from');
  assertRealDay(to, 'to');
  // 'YYYY-MM-DD' sorts chronologically, so the lexical comparison IS the date
  // comparison (the `lib/analytics/date-grain.ts` property).
  if (from > to) {
    throw new AppError('`to` must not be before `from`', 'VALIDATION_ERROR', 400);
  }
  const spanDays =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS + 1;
  if (spanDays > MAX_SPAN_DAYS) {
    throw new AppError(
      `the window may span at most ${MAX_SPAN_DAYS} days`,
      'VALIDATION_ERROR',
      400
    );
  }
}

/**
 * GET /api/reconciliation/attribution?from&to&class&orderNumber&limit&cursor
 * (reconciliation lane, pack C2a.5; spec REV-7 §5).
 *
 * Every ATTRIBUTABLE outbound batch in the window, with its class, its bounds
 * and its exclusions — the producer's envelope, returned verbatim. `from`/`to`
 * are ISO day keys and `to` is INCLUSIVE end-of-day UTC.
 *
 * ADMIN-ONLY and viewer `admin`: this surface is the app's admin bypass, so
 * there is no membership scoping here. The MEMBER half of the producer's viewer
 * contract belongs to the assistant tool (spec D9), not to this route.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const params = request.nextUrl.searchParams;
  const query = AttributionReportQuerySchema.parse({
    from: params.get('from'),
    to: params.get('to'),
    class: params.get('class') ?? undefined,
    orderNumber: params.get('orderNumber') ?? undefined,
    limit: params.get('limit') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
  });
  assertWindow(query.from, query.to);

  const report = await getAttributionReport(
    {
      from: query.from,
      to: query.to,
      classKey: query.class,
      orderNumber: query.orderNumber,
      limit: query.limit,
      cursor: query.cursor,
    },
    { kind: 'admin' }
  );

  return NextResponse.json(report);
});
