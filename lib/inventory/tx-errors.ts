/**
 * lib/inventory/tx-errors.ts — the transient transaction-error contract
 * (pack REV-22 F3; rounds 2-5, esp. FDe-1/FDe-4).
 *
 * A LEAF module on purpose: `@/lib/inventory` is the most-mocked module in the
 * repo (a dozen suites replace it with one-key factories), and constants that
 * live there are `undefined` inside any code those suites drive. Nothing mocks
 * this file; it imports Prisma types only, so it is structurally Next-free.
 *
 * THE CLASSIFIER matches the repo's own precedent (`withDeadlockRetry`,
 * `lib/inventory.ts`; the booking retry, `lib/supply-orders/booking.ts`): a
 * Prisma KNOWN code is sufficient but NOT necessary — a deadlock raised through
 * `$executeRaw`/`$queryRaw` can surface as P2010 ("Raw query failed") or with
 * no code at all, carrying only the engine's sentence. Fulfil's hot path is
 * entirely raw, and the loc-1 mirror is the lane's one OBSERVED deadlock site,
 * so code-only matching would miss exactly the case that exists (FDe-1).
 *
 * Codes: P2034 = write conflict / deadlock; P2028 = the interactive-transaction
 * budget (Prisma also raises it for a misused tx client — a code defect that
 * then reads as "busy"; the error log keeps it diagnosable, an ACCEPTED trade);
 * P2024 = the pool timed out — reachable contention under the 30 s budgets, and
 * ALSO what sustained pool exhaustion looks like (the log line is the
 * discriminator; outside dev it prints name + MESSAGE only, so grep the message
 * texts, never the code).
 */
import { Prisma } from '@prisma/client';

export const TRANSIENT_TX_ERROR_CODES: ReadonlySet<string> = new Set([
  'P2028',
  'P2034',
  'P2024',
]);

export const TX_BUSY_MESSAGE = 'the system was busy with another change — try again';

/** The engine sentences a raw-statement transient carries when no P-code does. */
const TRANSIENT_MESSAGE = /deadlock|lock wait timeout|write conflict|connection pool/i;

/**
 * The message branch is gated to ENGINE-SHAPED errors (FDf-2): a bare
 * `instanceof Error` test would also match a JSON-parse SyntaxError, whose V8
 * message ECHOES ~30 bytes of the request body verbatim — a client POSTing the
 * word "deadlock" in a malformed body could spoof a 503 BUSY and poison the
 * contention signal. Engine-shaped = a Prisma client error object, or the raw
 * executor's own "Raw query failed. Code: `1213`. …" wrapping.
 */
function isEngineShaped(error: Error): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    /^Raw query failed/.test(error.message)
  );
}

export function isTransientTxError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    TRANSIENT_TX_ERROR_CODES.has(error.code)
  ) {
    return true;
  }
  return (
    error instanceof Error && isEngineShaped(error) && TRANSIENT_MESSAGE.test(error.message)
  );
}

/**
 * The optimistic-version conflict (moved here from lib/inventory.ts — FDf-4:
 * apiHandler's ladder tests it two rungs above the transient branch, and the
 * ladder must be mock-immune end-to-end; `@/lib/inventory` is the repo's
 * most-mocked module). Re-exported from lib/inventory.ts, so every existing
 * importer keeps the SAME class identity.
 */
export class OptimisticLockError extends Error {
  constructor(
    message: string,
    public currentVersion: number,
    public expectedVersion: number
  ) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}
