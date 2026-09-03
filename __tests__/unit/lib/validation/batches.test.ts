/**
 * THE BATCH ROUTES' SCHEMAS (reconciliation Part 2, pack CB2a.5).
 *
 * `MoveBatchSchema` is the move route's ONE body field, and `BatchIdParamSchema`
 * is the uuid guard the reverse and move routes run before any read. Both refuse
 * through `apiHandler`'s ZodError arm as the house 400 — there is no bespoke code
 * for a malformed batch id and none is invented.
 *
 * The Int32 ceiling is the F7 rule: a location id above it cannot name a row in
 * this schema, and a value the database would reject is refused at the edge
 * rather than inside a transaction holding locks.
 */

import { BatchIdParamSchema, MoveBatchSchema } from '@/lib/validation/batches';

describe('MoveBatchSchema', () => {
  it('accepts a positive integer location id', () => {
    expect(MoveBatchSchema.parse({ physicalLocationId: 7 })).toEqual({ physicalLocationId: 7 });
  });

  it('accepts exactly the Int32 ceiling and refuses one past it', () => {
    expect(MoveBatchSchema.safeParse({ physicalLocationId: 2147483647 }).success).toBe(true);
    expect(MoveBatchSchema.safeParse({ physicalLocationId: 2147483648 }).success).toBe(false);
  });

  it('refuses zero, a negative, a fraction, a string and an absent field', () => {
    expect(MoveBatchSchema.safeParse({ physicalLocationId: 0 }).success).toBe(false);
    expect(MoveBatchSchema.safeParse({ physicalLocationId: -7 }).success).toBe(false);
    expect(MoveBatchSchema.safeParse({ physicalLocationId: 7.5 }).success).toBe(false);
    expect(MoveBatchSchema.safeParse({ physicalLocationId: '7' }).success).toBe(false);
    expect(MoveBatchSchema.safeParse({}).success).toBe(false);
  });

  it('names ONE field — the ledger location is read from the batch, never sent', () => {
    const parsed = MoveBatchSchema.parse({ physicalLocationId: 7, ledgerLocationId: 3 });
    expect(Object.keys(parsed)).toEqual(['physicalLocationId']);
  });
});

describe('BatchIdParamSchema', () => {
  it('accepts a v4 uuid, which is what newBatchId() mints', () => {
    expect(BatchIdParamSchema.safeParse('3f2504e0-4f89-41d3-9a0c-0305e82c3301').success).toBe(true);
  });

  it('refuses a legacy or non-uuid batch id', () => {
    expect(BatchIdParamSchema.safeParse('RECON_BATCH_ID').success).toBe(false);
    expect(BatchIdParamSchema.safeParse('ledger-batch-1').success).toBe(false);
    expect(BatchIdParamSchema.safeParse('').success).toBe(false);
  });

  // F26: a uuid is case-insensitive on the wire, but `newBatchId()` mints
  // lowercase and the parsed value is what rides into the discovery SQL, the
  // audit event's `entityId`, its `action` sentence and the 200 body. One
  // spelling — the ledger's — from the edge inwards.
  it('LOWERCASES a mixed-case uuid rather than carrying the caller spelling', () => {
    expect(BatchIdParamSchema.parse('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );
    expect(BatchIdParamSchema.parse('3f2504e0-4F89-41d3-9A0c-0305e82c3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );
  });

  it('leaves an already-lowercase uuid exactly as it was', () => {
    expect(BatchIdParamSchema.parse('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );
  });

  it('refuses with a plain zod message — apiHandler renders it as VALIDATION_ERROR', () => {
    const parsed = BatchIdParamSchema.safeParse('not-a-uuid');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(typeof parsed.error.errors[0].message).toBe('string');
      expect(parsed.error.errors[0].message).not.toContain('INVALID_BATCH_ID');
    }
  });
});
