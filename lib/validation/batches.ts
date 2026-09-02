import { z } from 'zod';

/** The INT32 ceiling every id column here sits under — see the fulfilment schema's note. */
const INT32_MAX = 2147483647;

/**
 * The body of a wrong-location MOVE (reconciliation Part 2, pack CB2a.5; spec
 * §2.6). ONE field: where the stock PHYSICALLY went. The ledger location is read
 * from the batch's own rows, never sent by the client — a caller that could name
 * both ends could reclassify a batch it never looked at.
 *
 * The reverse route takes NO body and parses none.
 */
export const MoveBatchSchema = z.object({
  physicalLocationId: z.number().int().positive().max(INT32_MAX),
});

/**
 * The `params.batchId` guard for the reverse and move routes.
 *
 * A ledger batch id is a v4 uuid (`newBatchId()`), and both routes call this
 * before any read so a malformed id costs a statement rather than a scan. A
 * non-uuid renders through `apiHandler`'s ZodError arm as
 * `{ error: <zod message>, code: 'VALIDATION_ERROR' }` — the house 400; there is
 * no bespoke code for it and none is invented here.
 *
 * NOT for the attribution route, whose ladder answers legacy and non-uuid batch
 * ids on their own terms.
 */
export const BatchIdParamSchema = z.string().uuid();

export type MoveBatchRequest = z.infer<typeof MoveBatchSchema>;
