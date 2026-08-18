/**
 * @jest-environment node
 *
 * Unit tests for `lib/supply-orders/product-resolve.ts` — THE ONE PRODUCT
 * RESOLVER the supply-order flow uses (contract pack C2c.2; seam S10).
 *
 * Two contracts live here, and they pull in opposite directions on purpose:
 *
 *   THE APPROVAL GATE. An order line may point at an APPROVED product, or at a
 *   PENDING_REVIEW product THE ACTOR CREATED — and nothing else. Admin status
 *   does NOT bypass the ownership half (spec §3: an admin approves the product
 *   first, which is a deliberate act, rather than silently ordering against
 *   somebody else's unreviewed row).
 *
 *   THE CREATE MAPPING IS `POST /api/products`, EXACTLY (PK2-3). The route's
 *   mapping is re-homed here ONCE so the two cannot drift — with one deliberate
 *   difference: `costPrice` is ALWAYS null, because a product created while
 *   entering an order is priced by the receipt (premise 1), never by the form.
 *   The pin below writes the expected `data` object out in full and imports
 *   NOTHING from the route: a contract test that read the route's code could
 *   only ever prove the two agree with themselves.
 *
 * The tx is mocked — no DB. What matters is which statements are issued and
 * with what payload.
 */

import { AppError } from '@/lib/error-handling';
import { resolveSupplyOrderProduct } from '@/lib/supply-orders/product-resolve';

const ACTOR = { id: 7, isAdmin: false };
const ADMIN = { id: 9, isAdmin: true };

/** The full new-product payload a line can carry (costPrice is not accepted). */
function productFields(overrides: Record<string, unknown> = {}) {
  return {
    baseName: 'Peptide X',
    variant: '10mg',
    unit: 'mg',
    numericValue: 10,
    lowStockThreshold: 5,
    retailPrice: 99.5,
    locationId: 3,
    ...overrides,
  } as never;
}

function mkTx(options: {
  existing?: Record<string, unknown> | null;
  duplicate?: Record<string, unknown> | null;
  location?: Record<string, unknown> | null;
  createdId?: number;
} = {}) {
  const {
    existing = null,
    duplicate = null,
    location = { id: 3, name: 'Warehouse' },
    createdId = 501,
  } = options;

  const statements: { kind: string; args?: unknown }[] = [];

  const tx = {
    statements,
    product: {
      findUnique: jest.fn(async (args: unknown) => {
        statements.push({ kind: 'product-find', args });
        return existing;
      }),
      findFirst: jest.fn(async (args: unknown) => {
        statements.push({ kind: 'duplicate-check', args });
        return duplicate;
      }),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        statements.push({ kind: 'product-create', args });
        return { id: createdId, ...args.data };
      }),
    },
    location: {
      findUnique: jest.fn(async (args: unknown) => {
        statements.push({ kind: 'location-check', args });
        return location;
      }),
    },
    productReorderConfig: {
      create: jest.fn(async (args: unknown) => {
        statements.push({ kind: 'reorder-config-create', args });
        return {};
      }),
    },
  };

  return tx as never as Parameters<typeof resolveSupplyOrderProduct>[0] & typeof tx;
}

const kinds = (tx: { statements: { kind: string }[] }) => tx.statements.map((s) => s.kind);
const stmt = (tx: { statements: { kind: string; args?: unknown }[] }, kind: string) =>
  tx.statements.find((s) => s.kind === kind);

describe('mode: existing — the approval gate (spec §3)', () => {
  it('accepts an APPROVED product and answers with its name + location', async () => {
    const tx = mkTx({
      existing: {
        id: 42,
        name: 'Peptide X 10mg',
        approvalStatus: 'APPROVED',
        deletedAt: null,
        createdBy: 99,
        location: 2,
      },
    });

    const resolved = await resolveSupplyOrderProduct(tx, { mode: 'existing', productId: 42 }, ACTOR);

    expect(resolved).toEqual({
      productId: 42,
      productName: 'Peptide X 10mg',
      approvalStatus: 'APPROVED',
      created: false,
      locationId: 2,
    });
    // A plain read: resolving a product is not a counter and takes no lock.
    expect(kinds(tx)).toEqual(['product-find']);
  });

  it('accepts the actor\'s OWN pending product (re-ordering what you created)', async () => {
    const tx = mkTx({
      existing: {
        id: 42,
        name: 'Peptide X 10mg',
        approvalStatus: 'PENDING_REVIEW',
        deletedAt: null,
        createdBy: ACTOR.id,
        location: 1,
      },
    });

    const resolved = await resolveSupplyOrderProduct(tx, { mode: 'existing', productId: 42 }, ACTOR);

    expect(resolved.productId).toBe(42);
    expect(resolved.approvalStatus).toBe('PENDING_REVIEW');
    expect(resolved.created).toBe(false);
  });

  it('REFUSES a foreign pending product — and an ADMIN does not bypass ownership', async () => {
    const tx = mkTx({
      existing: {
        id: 42,
        name: 'Peptide X 10mg',
        approvalStatus: 'PENDING_REVIEW',
        deletedAt: null,
        createdBy: 3,
        location: 1,
      },
    });

    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'existing', productId: 42 }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'existing', productId: 42 }, ADMIN),
    ).rejects.toThrow(/pending approval/i);
  });

  it('refuses a missing product with 400', async () => {
    const tx = mkTx({ existing: null });

    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'existing', productId: 42 }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a DECLINED (soft-deleted) product with 400', async () => {
    const tx = mkTx({
      existing: {
        id: 42,
        name: 'Peptide X 10mg',
        approvalStatus: 'APPROVED',
        deletedAt: new Date('2026-08-01T00:00:00.000Z'),
        createdBy: ACTOR.id,
        location: 1,
      },
    });

    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'existing', productId: 42 }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('mode: new — the `POST /api/products` mapping, re-homed once (PK2-3)', () => {
  it('writes a create payload BYTE-EQUAL to the route\'s mapping, with costPrice ALWAYS null', async () => {
    const tx = mkTx();

    const resolved = await resolveSupplyOrderProduct(
      tx,
      { mode: 'new', productFields: productFields() },
      ACTOR,
    );

    // Written out in full, importing nothing from the route: this object IS the
    // contract. `costPrice: null` ALWAYS (premise 1); `approvalStatus` from the
    // actor (non-admin -> PENDING_REVIEW); `quantity: 0` and no stock.
    expect((stmt(tx, 'product-create') as { args: { data: unknown } }).args.data).toEqual({
      name: 'Peptide X 10mg',
      baseName: 'Peptide X',
      variant: '10mg',
      unit: 'mg',
      numericValue: 10,
      quantity: 0,
      location: 3,
      lowStockThreshold: 5,
      costPrice: null,
      retailPrice: 99.5,
      approvalStatus: 'PENDING_REVIEW',
      createdBy: 7,
    });

    expect(resolved).toEqual({
      productId: 501,
      productName: 'Peptide X 10mg',
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      locationId: 3,
    });
  });

  it('normalizes exactly as the route does (trim / lowercase unit / name format)', async () => {
    const tx = mkTx();

    await resolveSupplyOrderProduct(
      tx,
      {
        mode: 'new',
        productFields: productFields({
          baseName: '  Peptide X  ',
          variant: ' 10mg ',
          unit: ' MG ',
          numericValue: undefined,
          lowStockThreshold: undefined,
          retailPrice: undefined,
          locationId: undefined,
        }),
      },
      ADMIN,
    );

    expect((stmt(tx, 'product-create') as { args: { data: unknown } }).args.data).toEqual({
      name: 'Peptide X 10mg',
      baseName: 'Peptide X',
      variant: '10mg',
      unit: 'mg',
      numericValue: null,
      quantity: 0,
      // locationId omitted -> the house default 1.
      location: 1,
      // undefined -> NULL (inherit the system default), never a materialized 10.
      lowStockThreshold: null,
      costPrice: null,
      retailPrice: null,
      // An admin's creation is auto-approved.
      approvalStatus: 'APPROVED',
      createdBy: 9,
    });
  });

  it('checks the location and refuses an unknown one with 400', async () => {
    const tx = mkTx({ location: null });

    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'new', productFields: productFields() }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((stmt(tx, 'location-check') as { args: unknown }).args).toEqual({ where: { id: 3 } });
    expect(kinds(tx)).not.toContain('product-create');
  });

  it('refuses a DUPLICATE with the route\'s exact 400 message (not a 409)', async () => {
    const tx = mkTx({ duplicate: { id: 12 } });

    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'new', productFields: productFields() }, ACTOR),
    ).rejects.toThrow('Product with this base name and variant already exists');
    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'new', productFields: productFields() }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect((stmt(tx, 'duplicate-check') as { args: unknown }).args).toEqual({
      where: { baseName: 'Peptide X', variant: '10mg', deletedAt: null },
    });
    expect(kinds(tx)).not.toContain('product-create');
  });

  it('creates the reorder config ONLY when a field is actually set', async () => {
    const withoutConfig = mkTx();
    await resolveSupplyOrderProduct(
      withoutConfig,
      { mode: 'new', productFields: productFields({ reorderConfig: {} }) },
      ACTOR,
    );
    expect(kinds(withoutConfig)).not.toContain('reorder-config-create');

    const withConfig = mkTx();
    await resolveSupplyOrderProduct(
      withConfig,
      { mode: 'new', productFields: productFields({ reorderConfig: { leadTimeDays: 14 } }) },
      ACTOR,
    );
    expect((stmt(withConfig, 'reorder-config-create') as { args: unknown }).args).toEqual({
      data: {
        productId: 501,
        leadTimeDays: 14,
        customSafetyStockDays: null,
        minOrderQuantity: 1,
        reorderPointOverride: null,
      },
    });
  });

  it('never creates a product before the duplicate + location checks have passed', async () => {
    const tx = mkTx();

    await resolveSupplyOrderProduct(
      tx,
      { mode: 'new', productFields: productFields() },
      ACTOR,
    );

    const order = kinds(tx);
    expect(order.indexOf('product-create')).toBeGreaterThan(order.indexOf('duplicate-check'));
    expect(order.indexOf('product-create')).toBeGreaterThan(order.indexOf('location-check'));
  });
});

describe('the refusals are house AppErrors', () => {
  it('throws AppError so `apiHandler` renders the house envelope', async () => {
    const tx = mkTx({ existing: null });

    await expect(
      resolveSupplyOrderProduct(tx, { mode: 'existing', productId: 42 }, ACTOR),
    ).rejects.toBeInstanceOf(AppError);
  });
});
