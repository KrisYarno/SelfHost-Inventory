/**
 * THE REFUSAL SENTENCES AND THE ONE ENVELOPE MAPPER (reconciliation Part 2, pack
 * CB2a.3; spec §5).
 *
 * Two surfaces are pinned here.
 *
 * THE SENTENCES. Every message below is rendered to an OPERATOR verbatim, so
 * they are quoted verbatim: a refusal that does not name its numbers sends
 * somebody back to the report to guess, and a refusal that names a customer
 * breaks the lane's PII rule. They carry ids, units and location ids, and
 * nothing else.
 *
 * THE ENVELOPES. `refusalResponse` is the ONE assembly the three batch routes
 * share, and `isAdmin` is REQUIRED: order identity is member-scoped, so
 * `BATCH_MOVED` and `MIXED_STAMPS` redact in their non-admin arms while every
 * other branch answers the same either way. The existing seven envelopes are
 * byte-identical to what the attribution route rendered before the move — its
 * own suite pins them from the wire side; this file pins them from the mapper's.
 */

import {
  AlreadyMovedRefusal,
  AlreadyReversedRefusal,
  BatchMovedRefusal,
  BatchRestoredRefusal,
  FulfilledBatchRefusal,
  InsufficientAtSourceRefusal,
  MANUAL_ATTRIBUTION_ROW_LIMIT,
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
import { refusalResponse } from '@/lib/reconciliation/refusal-response';

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

async function render(err: unknown, isAdmin = true) {
  const res = refusalResponse(err, { isAdmin });
  if (res === null) return null;
  return { status: res.status, body: await res.json() };
}

describe('the eight new refusal sentences (rendered to operators verbatim)', () => {
  it('ALREADY_REVERSED names both figures', () => {
    expect(new AlreadyReversedRefusal(6, 10).message).toBe(
      'This batch was already reversed — 6 of 10 units were put back',
    );
  });

  it('ALREADY_MOVED renders the timestamp to the minute in UTC, never a raw ISO string', () => {
    const err = new AlreadyMovedRefusal(7, '2026-09-02T14:31:22.000Z');
    expect(err.message).toBe(
      'This batch was moved to location 7 on 2026-09-02 14:31 UTC — it can no longer be re-attributed or moved again',
    );
    expect(err.message).not.toContain('T14:31');
  });

  it('BATCH_RESTORED names the units', () => {
    expect(new BatchRestoredRefusal(6).message).toBe(
      'This batch has already been put back (6 units) — it can no longer be re-attributed or moved',
    );
  });

  it('MULTI_LOCATION names the count AND the ids', () => {
    expect(new MultiLocationRefusal([3, 7, 9]).message).toBe(
      'This batch spans 3 locations (3, 7, 9) and cannot be moved as one',
    );
  });

  it('NULL_LOCATION_ROW names the row to repair', () => {
    expect(new NullLocationRowRefusal(501).message).toBe(
      'Ledger row 501 names no location — this batch cannot be reversed or moved until it is repaired',
    );
  });

  it('UNATTRIBUTED names who may act instead', () => {
    expect(new UnattributedRefusal().message).toBe(
      'This batch is not attributed to an order — only the person who recorded it or an admin can change it',
    );
  });

  it('SAME_LOCATION asks for the fix it wants', () => {
    expect(new SameLocationRefusal(3).message).toBe(
      "Location 3 is already this batch's ledger location — choose a different one",
    );
  });

  it('INSUFFICIENT_AT_SOURCE names both quantities and both ids', () => {
    expect(new InsufficientAtSourceRefusal(9, 7, 2, 5).message).toBe(
      'Location 7 has 2 of product 9 on the books — 5 needed to move this batch',
    );
  });
});

describe('the two widened refusals', () => {
  it('TOO_MANY_ROWS keeps its attribution sentence byte-identical by default', () => {
    expect(new TooManyRowsRefusal(51, 3).message).toBe(
      'This batch has 51 outbound rows across 3 products — above the 50-row manual attribution limit',
    );
    expect(new TooManyRowsRefusal(51, 3, MANUAL_ATTRIBUTION_ROW_LIMIT, 'attribution').message).toBe(
      'This batch has 51 outbound rows across 3 products — above the 50-row manual attribution limit',
    );
  });

  it('TOO_MANY_ROWS names the ACT and interpolates the limit for a reverse or a move', () => {
    const reverse = new TooManyRowsRefusal(51, 3, MANUAL_ATTRIBUTION_ROW_LIMIT, 'reverse');
    expect(reverse.message).toBe(
      'This batch has 51 rows across 3 products — above the 50-row limit for a reverse',
    );
    expect(new TooManyRowsRefusal(51, 3, 25, 'move').message).toBe(
      'This batch has 51 rows across 3 products — above the 25-row limit for a move',
    );
    // The constructor takes no batch id, so the copy cannot name one — the
    // request path already does. (Two REQUIRED positionals; `limit` and
    // `action` are defaulted and do not count toward `length`.)
    expect(TooManyRowsRefusal.length).toBe(2);
    expect(reverse).not.toHaveProperty('batchId');
  });

  it('FULFILLED_BATCH keeps the stamped sentence, and gains a null arm', () => {
    expect(new FulfilledBatchRefusal('ord-9', null).message).toBe(
      'Fulfilled against #ord-9 — change it via unfulfill/refulfill, not here',
    );
    expect(new FulfilledBatchRefusal('ord-9', '#1009').message).toBe(
      'Fulfilled against ##1009 — change it via unfulfill/refulfill, not here',
    );
    expect(new FulfilledBatchRefusal(null, null).message).toBe(
      'This fulfilled batch names no order — repair via unfulfill/refulfill',
    );
  });
});

describe('refusalResponse — the seven existing envelopes (admin arms unchanged)', () => {
  it('NOT_ATTRIBUTABLE 409', async () => {
    const err = new NotAttributableRefusal('b-1');
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'NOT_ATTRIBUTABLE', batchId: 'b-1' },
    });
  });

  it('TOO_MANY_ROWS 409', async () => {
    const err = new TooManyRowsRefusal(51, 3);
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'TOO_MANY_ROWS', rowCount: 51, productCount: 3, limit: 50 },
    });
  });

  it('MIXED_STAMPS 409 carries the ids for an admin', async () => {
    const err = new MixedStampsRefusal(['ord-1', 'ord-2']);
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'MIXED_STAMPS', orderRecordIds: ['ord-1', 'ord-2'] },
    });
  });

  it('BATCH_MOVED 409 carries both ids for an admin', async () => {
    const err = new BatchMovedRefusal('ord-2', 'ord-1');
    expect(await render(err)).toEqual({
      status: 409,
      body: {
        error: err.message,
        code: 'BATCH_MOVED',
        currentOrderRecordId: 'ord-2',
        expected: 'ord-1',
      },
    });
  });

  it('PARTIALLY_STAMPED 409', async () => {
    const err = new PartiallyStampedRefusal(1, 2);
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'PARTIALLY_STAMPED', stamped: 1, unstamped: 2 },
    });
  });

  it('FULFILLED_BATCH 409, with the now-nullable order id', async () => {
    expect(await render(new FulfilledBatchRefusal('ord-9', null))).toEqual({
      status: 409,
      body: {
        error: 'Fulfilled against #ord-9 — change it via unfulfill/refulfill, not here',
        code: 'FULFILLED_BATCH',
        orderRecordId: 'ord-9',
        orderNumber: null,
      },
    });
    expect(await render(new FulfilledBatchRefusal(null, null))).toEqual({
      status: 409,
      body: {
        error: 'This fulfilled batch names no order — repair via unfulfill/refulfill',
        code: 'FULFILLED_BATCH',
        orderRecordId: null,
        orderNumber: null,
      },
    });
  });

  it('R2B_OTHER_TARGET 409', async () => {
    const err = new R2bOtherTargetRefusal('ord-9');
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'R2B_OTHER_TARGET', fulfillmentOrderRecordId: 'ord-9' },
    });
  });
});

describe('refusalResponse — the non-admin arms redact order identity', () => {
  it('BATCH_MOVED drops currentOrderRecordId AND the sentence that spells it', async () => {
    expect(await render(new BatchMovedRefusal('ord-2', 'ord-1'), false)).toEqual({
      status: 409,
      body: {
        error: 'Someone attributed this batch while you were looking — refresh and try again',
        code: 'BATCH_MOVED',
        expected: 'ord-1',
      },
    });
  });

  it('MIXED_STAMPS answers the COUNT only', async () => {
    const err = new MixedStampsRefusal(['ord-1', 'ord-2']);
    expect(await render(err, false)).toEqual({
      status: 409,
      body: { error: err.message, code: 'MIXED_STAMPS', count: 2 },
    });
  });

  it('every other branch is identical for a member and an admin', async () => {
    const others: unknown[] = [
      new NotAttributableRefusal('b-1'),
      new TooManyRowsRefusal(51, 3),
      new PartiallyStampedRefusal(1, 2),
      new FulfilledBatchRefusal('ord-9', null),
      new R2bOtherTargetRefusal('ord-9'),
      new AlreadyReversedRefusal(6, 10),
      new AlreadyMovedRefusal(7, '2026-09-02T14:31:22.000Z'),
      new BatchRestoredRefusal(6),
      new MultiLocationRefusal([3, 7]),
      new NullLocationRowRefusal(501),
      new UnattributedRefusal(),
      new SameLocationRefusal(3),
      new InsufficientAtSourceRefusal(9, 7, 2, 5),
    ];
    for (const err of others) {
      expect(await render(err, false)).toEqual(await render(err, true));
    }
  });
});

describe('refusalResponse — the eight new envelopes and their statuses', () => {
  it('ALREADY_REVERSED 409', async () => {
    const err = new AlreadyReversedRefusal(6, 10);
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'ALREADY_REVERSED', previouslyRestored: 6, totalUnits: 10 },
    });
  });

  it('ALREADY_MOVED 409 carries the raw ISO instant beside the rendered sentence', async () => {
    const err = new AlreadyMovedRefusal(7, '2026-09-02T14:31:22.000Z');
    expect(await render(err)).toEqual({
      status: 409,
      body: {
        error: err.message,
        code: 'ALREADY_MOVED',
        physicalLocationId: 7,
        at: '2026-09-02T14:31:22.000Z',
      },
    });
  });

  it('BATCH_RESTORED 409', async () => {
    const err = new BatchRestoredRefusal(6);
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'BATCH_RESTORED', restoredUnits: 6 },
    });
  });

  it('MULTI_LOCATION 409', async () => {
    const err = new MultiLocationRefusal([3, 7]);
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'MULTI_LOCATION', locationIds: [3, 7] },
    });
  });

  it('NULL_LOCATION_ROW 409', async () => {
    const err = new NullLocationRowRefusal(501);
    expect(await render(err)).toEqual({
      status: 409,
      body: { error: err.message, code: 'NULL_LOCATION_ROW', rowId: 501 },
    });
  });

  it('UNATTRIBUTED is a 403 — an authorisation answer, not a state conflict', async () => {
    const err = new UnattributedRefusal();
    expect(await render(err)).toEqual({
      status: 403,
      body: { error: err.message, code: 'UNATTRIBUTED' },
    });
  });

  it('SAME_LOCATION is a 400 — the operator fixes it by choosing another location', async () => {
    const err = new SameLocationRefusal(3);
    expect(await render(err)).toEqual({
      status: 400,
      body: { error: err.message, code: 'SAME_LOCATION', locationId: 3 },
    });
  });

  it('INSUFFICIENT_AT_SOURCE 409', async () => {
    const err = new InsufficientAtSourceRefusal(9, 7, 2, 5);
    expect(await render(err)).toEqual({
      status: 409,
      body: {
        error: err.message,
        code: 'INSUFFICIENT_AT_SOURCE',
        productId: 9,
        locationId: 7,
        onBook: 2,
        needed: 5,
      },
    });
  });
});

describe('refusalResponse — anything else', () => {
  it('returns null so the caller rethrows and apiHandler renders it', () => {
    expect(refusalResponse(new Error('boom'), { isAdmin: true })).toBeNull();
    expect(refusalResponse(null, { isAdmin: false })).toBeNull();
    expect(refusalResponse({ code: 'BATCH_MOVED' }, { isAdmin: true })).toBeNull();
  });
});

describe('source pins (pack CB2a.3)', () => {
  it('refusals.ts stays Next-free and Prisma-free', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'lib/reconciliation/refusals.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from '@?next\//);
    expect(source).not.toContain("from 'next/");
    expect(source).not.toContain("from '@prisma/client'");
  });

  it('the attribution route no longer carries a local copy of the mapper', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'app/api/reconciliation/attribution/[batchId]/route.ts'),
      'utf8',
    );
    expect(source).not.toContain('function refusalResponse');
    expect(source).toContain("from '@/lib/reconciliation/refusal-response'");
    expect(source).toContain('refusalResponse(err, { isAdmin: true })');
  });
});
