/**
 * THE ONE REFUSAL ENVELOPE MAPPER (reconciliation Part 2, pack CB2a.3; spec §5).
 *
 * `apiHandler` renders an `AppError` as `{ error, code }` and nothing else, and
 * every refusal in `refusals.ts` has something further to name — which ids the
 * batch carries, how many units were already put back, which location holds too
 * few. Three routes now catch the same fifteen classes, so the assembly lives
 * here rather than being copied into each of them: a copy is not a copy, it is a
 * second answer to "what does BATCH_MOVED look like on the wire".
 *
 * THE ONE NEXT-BOUND MODULE in `lib/reconciliation/`, deliberately. `refusals.ts`
 * itself stays Next-free and Prisma-free because the report value-imports it and
 * the MCP sidecar bundles that graph with no `next/*` available; this file is
 * imported only by route code, which already has it.
 *
 * `isAdmin` IS REQUIRED. Order identity is member-scoped (spec D6), so the two
 * envelopes that would otherwise disclose an order id an approved non-admin
 * caller may not see — `BATCH_MOVED`'s `currentOrderRecordId` and
 * `MIXED_STAMPS`'s id list — redact in their non-admin arms. Making the flag
 * required rather than defaulted means a new caller that forgets to think about
 * it does not compile, which is the only version of fail-closed a boundary like
 * this can actually enforce.
 *
 * Returns `null` for anything that is not a refusal — the caller rethrows, and
 * `apiHandler` renders it.
 */

import { NextResponse } from 'next/server';

import {
  AlreadyMovedRefusal,
  AlreadyReversedRefusal,
  BatchMovedRefusal,
  BatchRestoredRefusal,
  FulfilledBatchRefusal,
  InsufficientAtSourceRefusal,
  MixedStampsRefusal,
  MultiLocationRefusal,
  NotAttributableRefusal,
  NullLocationRowRefusal,
  PartiallyStampedRefusal,
  R2bOtherTargetRefusal,
  SameLocationRefusal,
  TooManyRowsRefusal,
  UnattributedRefusal,
} from '@/lib/reconciliation/refusals';

export function refusalResponse(
  err: unknown,
  opts: { isAdmin: boolean },
): NextResponse | null {
  if (err instanceof NotAttributableRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, batchId: err.batchId },
      { status: 409 },
    );
  }
  if (err instanceof TooManyRowsRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        rowCount: err.rowCount,
        productCount: err.productCount,
        limit: err.limit,
      },
      { status: 409 },
    );
  }
  if (err instanceof MixedStampsRefusal) {
    // The ids are the repair an ADMIN makes. A member is told how many there
    // are, which is what the sentence already says, and nothing more.
    if (!opts.isAdmin) {
      return NextResponse.json(
        { error: err.message, code: err.code, count: err.orderRecordIds.length },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: err.message, code: err.code, orderRecordIds: err.orderRecordIds },
      { status: 409 },
    );
  }
  if (err instanceof BatchMovedRefusal) {
    // `currentOrderRecordId` is the id somebody ELSE attributed to, so the
    // non-admin arm drops it AND the sentence that spells it out. `expected` is
    // the caller's own claim and rides either way.
    if (!opts.isAdmin) {
      return NextResponse.json(
        {
          error: 'Someone attributed this batch while you were looking — refresh and try again',
          code: err.code,
          expected: err.expected,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        currentOrderRecordId: err.currentOrderRecordId,
        expected: err.expected,
      },
      { status: 409 },
    );
  }
  if (err instanceof PartiallyStampedRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, stamped: err.stamped, unstamped: err.unstamped },
      { status: 409 },
    );
  }
  if (err instanceof FulfilledBatchRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        orderRecordId: err.orderRecordId,
        orderNumber: err.orderNumber,
      },
      { status: 409 },
    );
  }
  if (err instanceof R2bOtherTargetRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        fulfillmentOrderRecordId: err.fulfillmentOrderRecordId,
      },
      { status: 409 },
    );
  }
  if (err instanceof AlreadyReversedRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        previouslyRestored: err.previouslyRestored,
        totalUnits: err.totalUnits,
      },
      { status: 409 },
    );
  }
  if (err instanceof AlreadyMovedRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        physicalLocationId: err.physicalLocationId,
        at: err.at,
      },
      { status: 409 },
    );
  }
  if (err instanceof BatchRestoredRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, restoredUnits: err.restoredUnits },
      { status: 409 },
    );
  }
  if (err instanceof MultiLocationRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, locationIds: err.locationIds },
      { status: 409 },
    );
  }
  if (err instanceof NullLocationRowRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, rowId: err.rowId },
      { status: 409 },
    );
  }
  if (err instanceof UnattributedRefusal) {
    // 403, not 409: this is an authorisation answer, not a state conflict.
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (err instanceof SameLocationRefusal) {
    // 400: the operator fixes it by choosing another location.
    return NextResponse.json(
      { error: err.message, code: err.code, locationId: err.locationId },
      { status: 400 },
    );
  }
  if (err instanceof InsufficientAtSourceRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        productId: err.productId,
        locationId: err.locationId,
        onBook: err.onBook,
        needed: err.needed,
      },
      { status: 409 },
    );
  }
  return null;
}
