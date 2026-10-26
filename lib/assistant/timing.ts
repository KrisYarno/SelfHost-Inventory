/**
 * lib/assistant/timing.ts — the three turn-lifecycle time constants (contract pack
 * T1; spec C2 step 2b + C4; A1 pack C5).
 *
 * This module is the ONLY definition of these values and imports NOTHING,
 * deliberately: `lib/assistant/threads.ts` needs the two timer bounds but must stay
 * `ai`-free (Spike B loads threads.ts against the real gate database with no `ai` in
 * its graph). Every importer — threads.ts, the chat route (which passes
 * PROVIDER_TIMEOUT_MS as `streamText({ timeout })`), the threads route, the tests and
 * the launch gate — imports from HERE. No other module defines or re-exports them
 * (A1 plan D6: one name, one place).
 *
 * The ordering PROVIDER < FINALIZE < CLAIM (90_000 < 105_000 < 120_000, 15 s gaps) is
 * DELIBERATE (spec REV-8): the provider timeout fires first, the route-owned
 * finalize deadline second, and the claim lease expires only after both — so a
 * bounded finalization always beats a takeover.
 *
 * 90 s is a CANCELLATION REQUEST, not a hard stream ceiling (A1 plan D6): a provider
 * that ignores the abort keeps the reader blocked until T2 finalizes and fences the
 * row.
 *
 * NONE of these is env-tunable, and no test may sleep on them: staleness fixtures
 * BACKDATE `createdAt` instead (design D7).
 *
 * MUST stay Next-free.
 */

/** T1: latches cause "provider-timeout" AND aborts the route controller. */
export const PROVIDER_TIMEOUT_MS = 90_000;

/** T2: force-runs the finalize-once latch with the accumulator's frozen snapshot. */
export const FINALIZE_DEADLINE_MS = 105_000;

/** Claim lease: a `running` chat request older than this is a dead claim, fenced by
 *  the next claim transaction (spec C2 step 2b). */
export const CLAIM_STALE_MS = 120_000;
