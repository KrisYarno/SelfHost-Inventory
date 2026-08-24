// @jest-environment node
//
// Reconciliation lane R-A (spec REV-7 D1, pack C1b.1) — THE ATTEMPT WRITER.
//
// One rule carries this module and it is a SAFETY rule, not a data rule: the
// attempt row must never abort the business write it describes, and it must
// never PRETEND the business write survived when it did not. Those two pull in
// opposite directions, and D1 REV-5 resolves them with a TRUE ALLOW-LIST:
//
//   SWALLOW  a Prisma VALIDATION error (client-side — it never reached the DB)
//            or a KNOWN-REQUEST error whose code is in SWALLOWABLE_REQUEST_CODES
//            (today: P2000 alone, value-too-long, proven statement-local on
//            MySQL — the statement rolls back, the transaction stays usable).
//   RE-THROW everything else.
//
// The inverse shape — enumerate the FATAL codes and swallow the rest — is the
// one this lane deliberately does NOT have. P2034 (write conflict / deadlock)
// and P2028 (transaction API error) are the famous ones, but MySQL has already
// discarded the transaction for a P2027 too, and a code minted by a future
// Prisma release is fatal-until-proven-otherwise. Swallowing one of those means
// Prisma COMMITs a transaction the server threw away and the route answers 200
// for a deduction that never landed. So the pins below are mostly PROPAGATION
// pins: they are what stops the allow-list quietly becoming a deny-list again.
import { Prisma } from '@prisma/client';

import {
  ATTEMPT_INSERT_FAILED_LOG,
  SWALLOWABLE_REQUEST_CODES,
  recordAttributionAttempt,
  type AttemptDetails,
  type AttemptInput,
} from '@/lib/attribution/attempts';

/** A tx whose ONLY delegate is the one the writer is allowed to touch. */
function makeTx(create: jest.Mock = jest.fn(async () => ({ id: 1 }))) {
  return {
    tx: { orderAttributionAttempt: { create } } as unknown as Prisma.TransactionClient,
    create,
  };
}

/** The identifying half of the minimum legal input — a batch-adjust row. */
const IDENTITY = {
  batchId: 'batch-1',
  ledgerRowId: 42,
  source: 'live-batch-adjust',
  actorUserId: 7,
} as const;

/**
 * Build one input. The CLASS is replaced wholesale rather than merged: an
 * `attributed` override must not inherit the baseline's `reason`, which is
 * exactly the mistake the row pins below exist to catch.
 */
function input(over: Partial<AttemptInput> = {}): AttemptInput {
  const { outcome, evidence, reason, ...rest } = over as Record<string, unknown>;
  const cls =
    outcome === undefined
      ? { outcome: 'none', reason: 'no-order-context' }
      : { outcome, evidence, reason };
  return { ...IDENTITY, ...cls, ...rest } as AttemptInput;
}

function knownRequest(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, {
    code,
    clientVersion: 'test',
  });
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('the swallow set is an ALLOW-LIST, and it is exactly {P2000}', () => {
  it('holds P2000 and nothing else', () => {
    expect(Array.from(SWALLOWABLE_REQUEST_CODES)).toEqual(['P2000']);
  });
});

describe('a failing insert PROPAGATES unless the tx is provably still usable', () => {
  // P2034/P2028: the transaction is already gone. P2027/P2035/P2036/P2037: the
  // complement of a fatal list could never prove otherwise for these. P2999: a
  // code this build has never seen. A plain Error: not Prisma's at all.
  it.each(['P2034', 'P2028', 'P2027', 'P2035', 'P2036', 'P2037', 'P2999'])(
    '%s re-throws (the caller aborts exactly as an audit failure would)',
    async (code) => {
      const { tx, create } = makeTx(
        jest.fn(async () => {
          throw knownRequest(code);
        }),
      );

      await expect(recordAttributionAttempt(tx, input())).rejects.toMatchObject({ code });
      expect(create).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it('a plain Error re-throws', async () => {
    const { tx } = makeTx(
      jest.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    await expect(recordAttributionAttempt(tx, input())).rejects.toThrow('socket hang up');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('the two swallowable classes cost only the attempt row', () => {
  it('P2000 is swallowed and logs the redacted token exactly ONCE', async () => {
    const { tx } = makeTx(
      jest.fn(async () => {
        throw knownRequest('P2000');
      }),
    );

    await expect(recordAttributionAttempt(tx, input())).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain(ATTEMPT_INSERT_FAILED_LOG);
    expect(line).toContain('P2000');
    expect(line).toContain('business write proceeds');
  });

  it('the log line carries the CODE and never the input', async () => {
    // The typed order reference is free text and free text is where customer
    // names arrive. The writer does not even receive it — this pin says the
    // things it DOES receive never reach a log either.
    const { tx } = makeTx(
      jest.fn(async () => {
        throw knownRequest('P2000');
      }),
    );

    await recordAttributionAttempt(
      tx,
      input({ batchId: 'batch-secret', orderRecordId: 'order-secret' }),
    );

    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).not.toContain('batch-secret');
    expect(line).not.toContain('order-secret');
  });

  it('a PrismaClientValidationError is swallowed (it never reached the DB)', async () => {
    const { tx } = makeTx(
      jest.fn(async () => {
        throw new Prisma.PrismaClientValidationError('bad shape', { clientVersion: 'test' });
      }),
    );

    await expect(recordAttributionAttempt(tx, input())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain(ATTEMPT_INSERT_FAILED_LOG);
  });
});

describe('the row the writer builds', () => {
  it('is written through the ONE delegate call, with attemptedAt left to the DB', async () => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(
      tx,
      input({ outcome: 'attributed', evidence: 'fulfillment' }),
    );

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect('attemptedAt' in data).toBe(false);
  });

  const CLASSES: Array<[string, Partial<AttemptInput>, { evidence: string | null; reason: string | null }]> = [
    ['attributed/fulfillment', { outcome: 'attributed', evidence: 'fulfillment' }, { evidence: 'fulfillment', reason: null }],
    ['attributed/selected', { outcome: 'attributed', evidence: 'selected' }, { evidence: 'selected', reason: null }],
    ['attributed/reference-resolved', { outcome: 'attributed', evidence: 'reference-resolved' }, { evidence: 'reference-resolved', reason: null }],
    ['attributed/manual', { outcome: 'attributed', evidence: 'manual' }, { evidence: 'manual', reason: null }],
    ['declined/unusable', { outcome: 'declined', reason: 'unusable' }, { evidence: null, reason: 'unusable' }],
    ['declined/unmatched', { outcome: 'declined', reason: 'unmatched' }, { evidence: null, reason: 'unmatched' }],
    ['declined/ambiguous', { outcome: 'declined', reason: 'ambiguous' }, { evidence: null, reason: 'ambiguous' }],
    ['declined/not-a-member', { outcome: 'declined', reason: 'not-a-member' }, { evidence: null, reason: 'not-a-member' }],
    ['declined/resolver-error', { outcome: 'declined', reason: 'resolver-error' }, { evidence: null, reason: 'resolver-error' }],
    ['none/no-reference-typed', { outcome: 'none', reason: 'no-reference-typed' }, { evidence: null, reason: 'no-reference-typed' }],
    ['none/explicit-non-order-intent', { outcome: 'none', reason: 'explicit-non-order-intent' }, { evidence: null, reason: 'explicit-non-order-intent' }],
    ['none/order-intent-no-id', { outcome: 'none', reason: 'order-intent-no-id' }, { evidence: null, reason: 'order-intent-no-id' }],
    ['none/no-order-context', { outcome: 'none', reason: 'no-order-context' }, { evidence: null, reason: 'no-order-context' }],
  ];

  it.each(CLASSES)('%s maps to the exact columns (absent = NULL, never "undefined")', async (_name, cls, expected) => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(tx, input(cls));

    const data = create.mock.calls[0][0].data;
    expect(data.outcome).toBe(cls.outcome);
    expect(data.evidence).toBe(expected.evidence);
    expect(data.reason).toBe(expected.reason);
    // A VarChar column holding the STRING 'undefined' is the failure this pin
    // exists for: it reads as a recorded class in every later report.
    expect(data.evidence).not.toBe('undefined');
    expect(data.reason).not.toBe('undefined');
  });

  it('carries the soft refs and the actor, defaulting the absent ones to NULL', async () => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(
      tx,
      input({
        outcome: 'attributed',
        evidence: 'fulfillment',
        batchId: 'batch-9',
        ledgerRowId: 77,
        source: 'fulfillment',
        actorUserId: 3,
        orderRecordId: 'order-9',
      }),
    );

    expect(create.mock.calls[0][0].data).toEqual({
      batchId: 'batch-9',
      ledgerRowId: 77,
      outcome: 'attributed',
      evidence: 'fulfillment',
      reason: null,
      orderRecordId: 'order-9',
      previousOrderRecordId: null,
      source: 'fulfillment',
      actorUserId: 3,
    });
  });

  it('a bundle-only fulfillment writes ledgerRowId NULL, not a sentinel', async () => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(
      tx,
      input({ outcome: 'attributed', evidence: 'fulfillment', ledgerRowId: null }),
    );

    expect(create.mock.calls[0][0].data.ledgerRowId).toBeNull();
  });
});

describe('details is built by EXPLICIT PICK, never a spread', () => {
  it('an unknown key on the caller object cannot survive', async () => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(
      tx,
      input({ details: { intent: 'order', evil: 1 } as unknown as AttemptDetails }),
    );

    expect(create.mock.calls[0][0].data.details).toEqual({ intent: 'order' });
  });

  it('picks all four declared keys and nothing else', async () => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(
      tx,
      input({
        details: {
          intent: 'damage-loss',
          overwriteReason: 'wrong order',
          rowCount: 4,
          completedFulfillment: true,
        },
      }),
    );

    expect(create.mock.calls[0][0].data.details).toEqual({
      intent: 'damage-loss',
      overwriteReason: 'wrong order',
      rowCount: 4,
      completedFulfillment: true,
    });
  });

  it('EMPTY details omits the field entirely (the column is NULL, not JSON null)', async () => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(tx, input({ details: {} }));

    expect('details' in create.mock.calls[0][0].data).toBe(false);
  });

  it('absent details omits the field too', async () => {
    const { tx, create } = makeTx();

    await recordAttributionAttempt(tx, input());

    expect('details' in create.mock.calls[0][0].data).toBe(false);
  });

  it('the writer never throws on a shape it dislikes (D1: it validates nothing)', async () => {
    const { tx } = makeTx();

    await expect(
      recordAttributionAttempt(tx, input({ details: { rowCount: 'nine' } as unknown as AttemptDetails })),
    ).resolves.toBeUndefined();
  });
});
