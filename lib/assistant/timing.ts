/**
 * lib/assistant/timing.ts — the three turn-lifecycle time constants (contract pack
 * T1; spec C2 step 2b + C4).
 *
 * This module is the SOLE home of these values and imports NOTHING, deliberately:
 * `lib/assistant/threads.ts` needs the two timer bounds but must stay `ai`-free
 * (Spike B loads threads.ts against the real gate database with no `ai` in its
 * graph), and `lib/assistant/providers.ts` — which does import `ai` — is where
 * `PROVIDER_TIMEOUT_MS` was born. Keeping the numbers here breaks that edge without
 * duplicating them. providers.ts MAY re-export PROVIDER_TIMEOUT_MS.
 *
 * The ordering 60_000 < 75_000 < 90_000 is DELIBERATE (spec REV-8): the provider
 * timeout fires first, the route-owned finalize deadline second, and the claim lease
 * expires only after both — so a bounded finalization always beats a takeover.
 * NONE of these is env-tunable, and no test may sleep on them: staleness fixtures
 * BACKDATE `createdAt` instead (design D7).
 *
 * MUST stay Next-free.
 */

/** T1: latches cause "provider-timeout" AND aborts the route controller. */
export const PROVIDER_TIMEOUT_MS = 60_000;

/** T2: force-runs the finalize-once latch with the accumulator's frozen snapshot. */
export const FINALIZE_DEADLINE_MS = 75_000;

/** Claim lease: a `running` chat request older than this is a dead claim, fenced by
 *  the next claim transaction (spec C2 step 2b). */
export const CLAIM_STALE_MS = 90_000;
