/**
 * @jest-environment node
 *
 * Unit tests for `lib/supply-orders/refusals.ts` — the THREE structured refusal
 * classes (contract pack C2c.0, seam S15).
 *
 * `apiHandler` renders an `AppError` as `{ error, code }` and nothing else, so a
 * refusal that has to NAME something — which lines are unverified, what the
 * counters actually were — cannot ride one. These classes carry the details from
 * a TX-SCOPED core out through the route's retry wrapper, where the route turns
 * them into the frozen 409 envelopes.
 *
 * Two properties are the whole contract:
 *
 *   1. EVERY FIELD SURVIVES. The envelope is assembled from these fields alone
 *      (`{ error, code, ...details }`), so a dropped one is a lie in the API.
 *   2. `instanceof` SURVIVES THE RETRY WRAPPER. The route catches AFTER
 *      `withBookingRetry` / `withDeadlockRetry`, so the class must still be
 *      recognisable once it has been rethrown through an async boundary — the
 *      one way this could quietly regress into a 500.
 *
 * Pure module: no Prisma, no Next, no mocks needed.
 */

import {
  UnverifiedRefusal,
  VerifiedLockedRefusal,
  CeilingRefusal,
} from '@/lib/supply-orders/refusals';

/** The shape of a route's retry wrapper: an async boundary that rethrows. */
async function throughRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e;
  }
}

describe('UnverifiedRefusal — the close that names its ORDERED lines', () => {
  it('carries the code and the line ids', () => {
    const refusal = new UnverifiedRefusal([7, 9]);

    expect(refusal.code).toBe('UNVERIFIED');
    expect(refusal.lineIds).toEqual([7, 9]);
  });

  it('is an Error with a message that names the lines', () => {
    const refusal = new UnverifiedRefusal([7, 9]);

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.message).toContain('7');
    expect(refusal.message).toContain('9');
  });

  it('names itself, so an unmapped throw is legible in a log', () => {
    expect(new UnverifiedRefusal([1]).name).toBe('UnverifiedRefusal');
  });
});

describe('VerifiedLockedRefusal — the verify a booking already froze', () => {
  it('carries the code and BOTH counters', () => {
    const refusal = new VerifiedLockedRefusal(4, 2);

    expect(refusal.code).toBe('VERIFIED_LOCKED');
    expect(refusal.stocked).toBe(4);
    expect(refusal.disposed).toBe(2);
  });

  it('keeps a 0 counter as a 0 (a stocked-nothing line is not an unknown)', () => {
    const refusal = new VerifiedLockedRefusal(0, 3);

    expect(refusal.stocked).toBe(0);
    expect(refusal.disposed).toBe(3);
  });
});

describe('CeilingRefusal — the batch that would book more than was verified', () => {
  it('carries the code and all FOUR counters, in the frozen envelope order', () => {
    const refusal = new CeilingRefusal(6, 1, 10, 5);

    expect(refusal.code).toBe('CEILING');
    expect(refusal.stocked).toBe(6);
    expect(refusal.disposed).toBe(1);
    expect(refusal.verified).toBe(10);
    expect(refusal.requested).toBe(5);
  });

  it('assembles the frozen 409 payload from its fields alone', () => {
    const refusal = new CeilingRefusal(6, 1, 10, 5);

    expect({
      error: refusal.message,
      code: refusal.code,
      stocked: refusal.stocked,
      disposed: refusal.disposed,
      verified: refusal.verified,
      requested: refusal.requested,
    }).toEqual({
      error: expect.any(String),
      code: 'CEILING',
      stocked: 6,
      disposed: 1,
      verified: 10,
      requested: 5,
    });
  });
});

describe('the retry wrapper (seam S15: the route catches AFTER it)', () => {
  it('every class survives `instanceof` through an async rethrow', async () => {
    const cases = [
      new UnverifiedRefusal([3]),
      new VerifiedLockedRefusal(1, 0),
      new CeilingRefusal(1, 0, 2, 3),
    ];

    for (const thrown of cases) {
      await expect(
        throughRetry(async () => {
          throw thrown;
        }),
      ).rejects.toBe(thrown);
    }

    await expect(
      throughRetry(async () => {
        throw new CeilingRefusal(1, 0, 2, 3);
      }),
    ).rejects.toBeInstanceOf(CeilingRefusal);
    await expect(
      throughRetry(async () => {
        throw new UnverifiedRefusal([3]);
      }),
    ).rejects.toBeInstanceOf(UnverifiedRefusal);
    await expect(
      throughRetry(async () => {
        throw new VerifiedLockedRefusal(1, 0);
      }),
    ).rejects.toBeInstanceOf(VerifiedLockedRefusal);
  });

  it('never answers to a SIBLING class (the three envelopes stay distinct)', () => {
    expect(new CeilingRefusal(1, 0, 2, 3)).not.toBeInstanceOf(UnverifiedRefusal);
    expect(new UnverifiedRefusal([1])).not.toBeInstanceOf(VerifiedLockedRefusal);
    expect(new VerifiedLockedRefusal(1, 0)).not.toBeInstanceOf(CeilingRefusal);
  });
});
