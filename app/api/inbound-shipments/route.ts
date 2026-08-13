import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { InboundShipmentStatus } from '@prisma/client';
import { recordChange } from '@/lib/change-tracking';
import {
  CreateInboundShipmentSchema,
  parseShipmentStatusFilter,
} from '@/lib/validation/inbound-shipment';
import { listInboundShipments, toShipmentSummary } from '@/lib/shipments/queries';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

// GET /api/inbound-shipments?status=OPEN - List receiving headers.
// Every quantity on each entry is computed on read from the linked staging
// lines (T4) — there is no stored rollup to go stale.
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const status = parseShipmentStatusFilter(request.nextUrl.searchParams.get('status'));

  const shipments = await listInboundShipments(status);

  return NextResponse.json({ shipments });
});

// POST /api/inbound-shipments - Open a receiving header (any approved user).
// A shipment carries no quantities of its own; lines arrive later by linking
// staging items to it (PATCH /api/staging-items/[id]).
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'inbound-shipments:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = CreateInboundShipmentSchema.parse(await request.json());

  // Create + record atomically (D4): the SHIPMENT_CREATE event shares the
  // create's transaction, so an unrecordable change never leaves a committed
  // shipment behind.
  const created = await prisma.$transaction(async (tx) => {
    const shipment = await tx.inboundShipment.create({
      data: {
        supplierRef: body.supplierRef ?? null,
        notes: body.notes ?? null,
        status: InboundShipmentStatus.OPEN,
        createdBy: user.id,
      },
      include: { creator: { select: { id: true, username: true } } },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'SHIPMENT_CREATE',
      entityType: 'SHIPMENT',
      entityId: shipment.id,
      action: `Opened inbound shipment ${shipment.id}`,
      details: { supplierRef: shipment.supplierRef },
    });

    return shipment;
  });

  // A fresh shipment has no lines; returning the SAME summary shape the list
  // serves (with an all-zero rollup) keeps create/list/detail on one contract.
  const response = NextResponse.json(toShipmentSummary(created, []), { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
