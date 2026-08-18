/**
 * STRUCTURED REFUSALS for the supply-order cores (contract pack C2c.0, seam S15).
 *
 * `apiHandler` renders an `AppError` as `{ error, code }` and nothing else, so a
 * refusal that has to NAME something cannot ride one — and these three all do:
 * which lines are still unverified, what the counters were when the ceiling was
 * hit, how much is already stocked against a line somebody is trying to re-count.
 * An operator who is told "conflict" and nothing else has to go and look; an
 * operator told "6 stocked, 1 disposed, 10 verified, you asked for 5" already
 * knows what to type next.
 *
 * So the cores throw THESE, the routes catch them AFTER the retry wrapper, and
 * the frozen 409 envelopes are assembled from their fields:
 *
 *   UNVERIFIED       `{ error, code, lineIds }`
 *   VERIFIED_LOCKED  `{ error, code, stocked, disposed }`
 *   CEILING          `{ error, code, stocked, disposed, verified, requested }`
 *
 * Unstructured refusals stay `AppError` (`CONFLICT`, `NOT_BOOKABLE`,
 * `LEGACY_READ_ONLY`, `PRODUCT_DECLINED`, `IDEMPOTENCY_MISMATCH`) and travel
 * through `apiHandler` untouched.
 *
 * Next-free, Prisma-free, dependency-free: the cores are TX-SCOPED and these
 * ride out of them into route code that has no business importing anything else.
 */

/**
 * A close was asked for while lines are still ORDERED — nothing has been
 * verified on them, so closing would settle a receipt nobody checked.
 */
export class UnverifiedRefusal extends Error {
  readonly code = 'UNVERIFIED';

  constructor(public readonly lineIds: number[]) {
    super(
      `The order still has unverified lines (${lineIds.join(', ')}); verify or discard them before closing`,
    );
    this.name = 'UnverifiedRefusal';
  }
}

/**
 * A verified count cannot move any more, because units have already been
 * stocked or disposed against it (spec §4.0): lowering below `stocked +
 * disposed` would make the line claim fewer units arrived than the ledger
 * already booked, and on an UNORDERED line any change at all would re-price
 * batches that are already frozen (D4).
 */
export class VerifiedLockedRefusal extends Error {
  readonly code = 'VERIFIED_LOCKED';

  constructor(
    public readonly stocked: number,
    public readonly disposed: number,
  ) {
    super(
      `The verified count is locked: ${stocked} unit(s) stocked and ${disposed} disposed against this line already`,
    );
    this.name = 'VerifiedLockedRefusal';
  }
}

/**
 * The batch would book more units than the line has left (D3). The counters
 * ride along because they are read from the LOCKED row — they are the current
 * truth, not the stale numbers the client was looking at.
 */
export class CeilingRefusal extends Error {
  readonly code = 'CEILING';

  constructor(
    public readonly stocked: number,
    public readonly disposed: number,
    public readonly verified: number,
    public readonly requested: number,
  ) {
    super(
      `Only ${verified - stocked - disposed} unit(s) remain on this line (${verified} verified, ${stocked} stocked, ${disposed} disposed); ${requested} were requested`,
    );
    this.name = 'CeilingRefusal';
  }
}
