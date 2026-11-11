import { z } from 'zod';

/**
 * THE house post-parse refusal (house rule 1, `lib/validation/supply-orders.ts`):
 * one cross-field rule broken -> one `ZodError` with the field's path and a
 * frozen sentence, which `apiHandler` renders as
 * `{ error: <the sentence>, code: 'VALIDATION_ERROR' }` with a 400. The path is
 * for the caller's tests; it never reaches the wire.
 *
 * MOVED here unchanged from `supply-orders.ts` (reconciliation Part 2, pack
 * CB3a-i.2) so the adjust request's truth table (`parseAdjustShape`,
 * `lib/validation/inventory.ts`) and the supply-order assertions share ONE
 * spelling.
 *
 * The explicit `: never` is LOAD-BEARING. It is what lets a guard such as
 * `if (shape.kind !== 'delta') refuse(…)` narrow `shape` for the code after it;
 * an inferred return type, or the same body as an arrow `const`, does not.
 *
 * Imports only `zod`: Next-free.
 */
export function refuse(path: (string | number)[], message: string): never {
  throw new z.ZodError([{ code: z.ZodIssueCode.custom, path, message }]);
}
