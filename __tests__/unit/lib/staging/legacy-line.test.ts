/**
 * @jest-environment node
 *
 * The legacy staging line's non-null assert (contract pack REV-2 C1.5 / P-7).
 *
 * The overhaul NULL-widens locationId, receivedBy and receivedAt on
 * `staging_items` — a supply-order line has none of them until it is verified
 * and labeled. The legacy read paths return only legacy rows, whose invariant is
 * that all three are present, so their wire contract keeps its non-null types.
 * These pins are what makes that a CHECKED invariant rather than a cast: each
 * scalar, nulled on its own, must throw INVARIANT/500 — not render a NULL
 * location as if the box had one.
 */

import { assertLegacyLine } from '@/lib/staging/legacy-line';
import { AppError } from '@/lib/error-handling';

const legacyRow = () => ({
  id: 500,
  description: 'legacy received box',
  locationId: 1,
  receivedBy: 900,
  receivedAt: new Date('2026-08-01T11:00:00Z'),
});

describe('assertLegacyLine', () => {
  it('passes a legacy row through and narrows it', () => {
    const row: {
      id: number;
      description: string;
      locationId: number | null;
      receivedBy: number | null;
      receivedAt: Date | null;
    } = legacyRow();

    expect(() => assertLegacyLine(row)).not.toThrow();

    assertLegacyLine(row);
    // after the assert the three scalars are non-null to the type system too
    const narrowed: { locationId: number; receivedBy: number; receivedAt: Date } = row;
    expect(narrowed.locationId).toBe(1);
    expect(narrowed.receivedBy).toBe(900);
    expect(narrowed.receivedAt.toISOString()).toBe('2026-08-01T11:00:00.000Z');
  });

  it.each(['locationId', 'receivedBy', 'receivedAt'] as const)(
    'throws INVARIANT/500 when %s alone is null',
    (field) => {
      const row = { ...legacyRow(), [field]: null };

      expect(() => assertLegacyLine(row)).toThrow(AppError);
      try {
        assertLegacyLine(row);
        throw new Error('expected assertLegacyLine to throw');
      } catch (error) {
        const appError = error as AppError;
        expect(appError.code).toBe('INVARIANT');
        expect(appError.statusCode).toBe(500);
        expect(appError.message).toBe(
          'legacy staging line missing locationId/receivedBy/receivedAt',
        );
      }
    },
  );

  it('throws when a brand-new supply-order line (all three null) reaches a legacy mapper', () => {
    const newFlowLine = {
      id: 503,
      description: 'new-flow line',
      locationId: null,
      receivedBy: null,
      receivedAt: null,
    };

    expect(() => assertLegacyLine(newFlowLine)).toThrow(AppError);
  });
});
