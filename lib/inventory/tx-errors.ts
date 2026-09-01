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

export function isTransientTxError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    TRANSIENT_TX_ERROR_CODES.has(error.code)
  ) {
    return true;
  }
  return error instanceof Error && TRANSIENT_MESSAGE.test(error.message);
}
