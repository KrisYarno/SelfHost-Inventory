// @jest-environment node
/**
 * W1-2b — the shipment claim guards (contract pack REV-3 T4 as amended).
 *
 * The STRANDED-LINE AMENDMENT lives HERE, at the claim level, not in the
 * callers: closing a shipment means "receiving is done", NOT "this box may
 * never become stock". So:
 *
 *   claimShipmentForCount       OPEN only            (CLOSED / CANCELLED -> 409)
 *   claimShipmentForGraduation  OPEN or CLOSED       (CANCELLED -> 409)
 *
 * Both are ATOMIC CLAIMS in the graduate.ts:69 idiom — an `updateMany` whose
 * WHERE *is* the precondition and whose data is a deliberate NO-OP (status set
 * to the SAME status it matched), so the value of the write is the row lock.
 * The multi-status guard therefore tries one status at a time: a single
 * `status: { in: [...] }` claim would have to pick ONE value to write, which
 * would silently reopen a closed shipment.
 */

import {
  applyShipmentLink,
  claimShipmentForCount,
  claimShipmentForGraduation,
} from '@/lib/shipments/lifecycle';
import { AppError } from '@/lib/error-handling';

const SHIPMENT = 'ckshipment00000000000000a';

function mkTx() {
  return {
    inboundShipment: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    stagingItem: {
      updateMany: jest.fn(),
    },
  } as any;
}

/** The claim attempts a guard made, as [id, status] pairs. */
const attempts = (tx: any) =>
  tx.inboundShipment.updateMany.mock.calls.map((c: any[]) => [c[0].where.id, c[0].where.status]);

/** Every claim write must be a no-op: data.status === where.status. */
const writesAreNoOps = (tx: any) =>
  tx.inboundShipment.updateMany.mock.calls.every((c: any[]) => c[0].data.status === c[0].where.status);

async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((e: AppError) => {
    expect(e.statusCode).toBe(statusCode);
  });
}

describe('claimShipmentForCount (OPEN only)', () => {
  it('claims an OPEN shipment with a single no-op lock write, and never reads', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    await expect(claimShipmentForCount(tx, SHIPMENT)).resolves.toBe('OPEN');

    expect(attempts(tx)).toEqual([[SHIPMENT, 'OPEN']]);
    expect(writesAreNoOps(tx)).toBe(true);
    // The read exists ONLY to separate 404 from 409 after a failed claim.
    expect(tx.inboundShipment.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a CLOSED shipment with 409 (counting is receiving work — it ended)', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    tx.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CLOSED' });

    await expectAppError(claimShipmentForCount(tx, SHIPMENT), 409);
    expect(attempts(tx)).toEqual([[SHIPMENT, 'OPEN']]);
  });

  it('rejects a CANCELLED shipment with 409', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    tx.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CANCELLED' });

    await expectAppError(claimShipmentForCount(tx, SHIPMENT), 409);
  });

  it('404s on an unknown id (the read runs only after nothing was written)', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    tx.inboundShipment.findUnique.mockResolvedValue(null);

    await expectAppError(claimShipmentForCount(tx, SHIPMENT), 404);
  });
});

describe('claimShipmentForGraduation (OPEN or CLOSED — the stranded-line amendment)', () => {
  it('claims an OPEN shipment on the first attempt', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    await expect(claimShipmentForGraduation(tx, SHIPMENT)).resolves.toBe('OPEN');

    expect(attempts(tx)).toEqual([[SHIPMENT, 'OPEN']]);
  });

  it('LEGAL on a CLOSED shipment: falls through to the CLOSED claim and returns CLOSED', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany
      .mockResolvedValueOnce({ count: 0 }) // not OPEN
      .mockResolvedValueOnce({ count: 1 }); // CLOSED — allowed

    await expect(claimShipmentForGraduation(tx, SHIPMENT)).resolves.toBe('CLOSED');

    expect(attempts(tx)).toEqual([
      [SHIPMENT, 'OPEN'],
      [SHIPMENT, 'CLOSED'],
    ]);
    // Neither attempt may rewrite the status — a CLOSED shipment must not be
    // reopened by the act of graduating one of its lines.
    expect(writesAreNoOps(tx)).toBe(true);
    expect(tx.inboundShipment.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a CANCELLED shipment with 409 after both claims miss', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    tx.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CANCELLED' });

    await expectAppError(claimShipmentForGraduation(tx, SHIPMENT), 409);
    expect(attempts(tx)).toEqual([
      [SHIPMENT, 'OPEN'],
      [SHIPMENT, 'CLOSED'],
    ]);
  });

  it('404s on an unknown id', async () => {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    tx.inboundShipment.findUnique.mockResolvedValue(null);

    await expectAppError(claimShipmentForGraduation(tx, SHIPMENT), 404);
  });

  it('RACE: OPEN -> CANCELLED between the two attempts still 409s (never graduates)', async () => {
    const tx = mkTx();
    // Both claims miss because the row moved to CANCELLED mid-flight.
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    tx.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CANCELLED' });

    await expectAppError(claimShipmentForGraduation(tx, SHIPMENT), 409);
  });
});

// ---------------------------------------------------------------------------
// W1S-2/W1S-7 (W1-C fix round) — the RELINK takes both headers in a canonical
// order. A relink is the one act that holds TWO shipment row locks at once, and
// two operators moving lines in opposite directions (A -> B and B -> A) took
// them in opposite orders: a textbook deadlock between two legal requests.
// Sorting by id makes the order a property of the PAIR, not of the direction.
// ---------------------------------------------------------------------------

describe('applyShipmentLink — deterministic multi-shipment lock order', () => {
  const A = 'ckshipment00000000000000a';
  const B = 'ckshipment00000000000000b';

  function linkTx() {
    const tx = mkTx();
    tx.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    tx.stagingItem.updateMany.mockResolvedValue({ count: 1 });
    return tx;
  }

  const claimedIds = (tx: any) =>
    tx.inboundShipment.updateMany.mock.calls.map((c: any[]) => c[0].where.id);

  it('claims A then B when moving A -> B', async () => {
    const tx = linkTx();

    await applyShipmentLink(tx, {
      item: { id: 5, status: 'RECEIVED' as any, shipmentId: A },
      targetShipmentId: B,
    });

    expect(claimedIds(tx)).toEqual([A, B]);
  });

  it('claims A then B when moving B -> A (the IDENTICAL order, not the request order)', async () => {
    const tx = linkTx();

    await applyShipmentLink(tx, {
      item: { id: 5, status: 'RECEIVED' as any, shipmentId: B },
      targetShipmentId: A,
    });

    // Source-then-target would have claimed B first here and deadlocked against
    // the A -> B relink above.
    expect(claimedIds(tx)).toEqual([A, B]);
  });

  it('a plain LINK claims only the target', async () => {
    const tx = linkTx();

    await applyShipmentLink(tx, {
      item: { id: 5, status: 'RECEIVED' as any, shipmentId: null },
      targetShipmentId: B,
    });

    expect(claimedIds(tx)).toEqual([B]);
  });

  it('a plain UNLINK claims only the shipment being left', async () => {
    const tx = linkTx();

    await applyShipmentLink(tx, {
      item: { id: 5, status: 'RECEIVED' as any, shipmentId: A },
      targetShipmentId: null,
    });

    expect(claimedIds(tx)).toEqual([A]);
  });
});

describe('the two guards diverge exactly where the amendment says they do', () => {
  it('CLOSED: count 409s, graduation succeeds', async () => {
    const countTx = mkTx();
    countTx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    countTx.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CLOSED' });
    await expectAppError(claimShipmentForCount(countTx, SHIPMENT), 409);

    const gradTx = mkTx();
    gradTx.inboundShipment.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await expect(claimShipmentForGraduation(gradTx, SHIPMENT)).resolves.toBe('CLOSED');
  });

  it('CANCELLED: both 409', async () => {
    for (const guard of [claimShipmentForCount, claimShipmentForGraduation]) {
      const tx = mkTx();
      tx.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
      tx.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CANCELLED' });
      await expectAppError(guard(tx, SHIPMENT), 409);
    }
  });
});
