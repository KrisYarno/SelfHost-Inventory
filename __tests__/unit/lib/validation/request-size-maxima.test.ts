/**
 * @jest-environment node
 *
 * REQUEST-SIZE MAXIMA on the four stock-writing schemas (reconciliation Part 2,
 * pack CB1b.5 / REV-15 PKb-11).
 *
 * The canonical prelock takes at most `MAX_PRELOCK_KEYS` rows in one statement
 * and throws a `RangeError` past it — a LIB BACKSTOP, which on the wire would be
 * an unhandled 500 saying nothing an operator can act on. So the four routes
 * that feed it bound their own item arrays instead, at 100, and the refusal is
 * an ordinary ZodError → 400 through the existing ladder. The two numbers are
 * deliberately different: the schema is the request contract, the backstop is
 * the library's, and unfulfill's bundles multiply keys between them (its own
 * `TOO_MANY_KEYS` guard covers that).
 *
 * One 101-item fixture per schema, plus the 100-item boundary, because an
 * off-by-one here silently reopens the RangeError path.
 */

import { MAX_PRELOCK_KEYS } from '@/lib/inventory/prelock';
import { BatchInventoryAdjustmentSchema } from '@/lib/validation/inventory';
import { FulfillmentRequestSchema } from '@/lib/validation/fulfillment';
import { UnfulfillRequestSchema } from '@/lib/validation/unfulfill';
import { SimpleDeductSchema } from '@/lib/validation/workbench';

const MAX_ITEMS = 100;
const MESSAGE = 'at most 100 items per request';

function list<T>(count: number, make: (i: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

const deductItems = (n: number) => list(n, (i) => ({ productId: i + 1, quantity: 1 }));
const fulfillItems = (n: number) => list(n, (i) => ({ itemId: `item-${i}`, quantity: 1 }));
const unfulfillItems = (n: number) =>
  list(n, (i) => ({ itemId: `item-${i}`, productId: i + 1, quantity: 1, locationId: 1 }));
const adjustments = (n: number) =>
  list(n, (i) => ({ productId: i + 1, locationId: 1, delta: -1 }));

/** Every message a failed parse carried, flattened. */
function messagesOf(result: { success: boolean; error?: { issues: Array<{ message: string }> } }) {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.message);
}

describe('the four feeding schemas cap their item arrays at 100', () => {
  it('SimpleDeductSchema.items — 100 passes, 101 is a 400-class ZodError', () => {
    const base = { locationId: 2 };
    expect(SimpleDeductSchema.safeParse({ ...base, items: deductItems(MAX_ITEMS) }).success).toBe(
      true
    );

    const over = SimpleDeductSchema.safeParse({ ...base, items: deductItems(MAX_ITEMS + 1) });
    expect(over.success).toBe(false);
    expect(messagesOf(over)).toContain(MESSAGE);
  });

  it('FulfillmentRequestSchema.items — 100 passes, 101 is a 400-class ZodError', () => {
    const base = { locationId: 5 };
    expect(
      FulfillmentRequestSchema.safeParse({ ...base, items: fulfillItems(MAX_ITEMS) }).success
    ).toBe(true);

    const over = FulfillmentRequestSchema.safeParse({ ...base, items: fulfillItems(MAX_ITEMS + 1) });
    expect(over.success).toBe(false);
    expect(messagesOf(over)).toContain(MESSAGE);
  });

  it('UnfulfillRequestSchema.items — 100 passes, 101 is a 400-class ZodError', () => {
    expect(UnfulfillRequestSchema.safeParse({ items: unfulfillItems(MAX_ITEMS) }).success).toBe(
      true
    );

    const over = UnfulfillRequestSchema.safeParse({ items: unfulfillItems(MAX_ITEMS + 1) });
    expect(over.success).toBe(false);
    expect(messagesOf(over)).toContain(MESSAGE);
  });

  it('BatchInventoryAdjustmentSchema.adjustments — 100 passes, 101 is a 400-class ZodError', () => {
    expect(
      BatchInventoryAdjustmentSchema.safeParse({ adjustments: adjustments(MAX_ITEMS) }).success
    ).toBe(true);

    const over = BatchInventoryAdjustmentSchema.safeParse({
      adjustments: adjustments(MAX_ITEMS + 1),
    });
    expect(over.success).toBe(false);
    expect(messagesOf(over)).toContain(MESSAGE);
  });

  it('the schema cap sits BELOW the prelock backstop, so the RangeError is unreachable here', () => {
    // Single-key-per-item routes cannot reach it at all; unfulfill's bundles can
    // multiply past it, which is why that route carries its own TOO_MANY_KEYS.
    expect(MAX_ITEMS).toBeLessThan(MAX_PRELOCK_KEYS);
  });
});
describe("BatchTransferSchema.transfers (QB-9)", () => {
  const { BatchTransferSchema } = jest.requireActual("@/lib/validation/inventory");
  const transfer = (i: number) => ({ fromLocationId: i + 2, quantity: 1 });
  it("accepts 100 and refuses 101 transfers with the split sentence", () => {
    const base = { productId: 1, toLocationId: 1 };
    expect(
      BatchTransferSchema.safeParse({
        ...base,
        transfers: Array.from({ length: 100 }, (_, i) => transfer(i)),
      }).success
    ).toBe(true);
    const over = BatchTransferSchema.safeParse({
      ...base,
      transfers: Array.from({ length: 101 }, (_, i) => transfer(i)),
    });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(JSON.stringify(over.error.issues)).toContain("at most 100 transfers per request");
    }
  });
});

