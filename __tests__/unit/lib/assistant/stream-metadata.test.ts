/**
 * @jest-environment node
 *
 * Assistant A1 (M2a, contract pack C4b) — the chat route's `messageMetadata` rule,
 * `lib/assistant/stream-metadata.ts`: the four branches (start, finish, abort, any
 * other part) under each of the three latch causes (null, "provider-timeout",
 * "client").
 *
 * The END-TO-END half of seam S2 (a real `abort` part through the real SDK, read back
 * with `readUIMessageStream`) is anthropic-wire.test.ts case (e).
 */

import { turnMessageMetadata } from "@/lib/assistant/stream-metadata";
import type { AbortCause } from "@/lib/assistant/threads";

const THREAD = "cthread-meta-0001";
const CAUSES: Array<AbortCause | null> = [null, "provider-timeout", "client"];

describe("turnMessageMetadata (C4b)", () => {
  describe.each(CAUSES)("cause %p", (cause) => {
    test('"start" -> { threadId }', () => {
      expect(turnMessageMetadata({ type: "start" }, cause, THREAD)).toEqual({ threadId: THREAD });
    });

    test('"finish" -> { finishReason, threadId }, the reason passed through unchanged (S3b)', () => {
      for (const finishReason of ["stop", "tool-calls", "length", "content-filter", "error", "other"]) {
        expect(turnMessageMetadata({ type: "finish", finishReason }, cause, THREAD)).toEqual({
          finishReason,
          threadId: THREAD,
        });
      }
    });

    test('"abort" -> PROVIDER_TIMEOUT unless the cause is the user\'s Stop', () => {
      const result = turnMessageMetadata({ type: "abort" }, cause, THREAD);
      if (cause === "client") {
        expect(result).toBeUndefined();
      } else {
        // null: the SDK's own timeout fired first (it merges AbortSignal.timeout into
        // the signal) — never the user's doing, the same belt classifyTurn applies.
        expect(result).toEqual({ errorCode: "PROVIDER_TIMEOUT", threadId: THREAD });
      }
    });

    test("any other part -> undefined (no metadata chunk)", () => {
      for (const type of ["text-delta", "text-start", "start-step", "finish-step", "tool-call", "error", "raw", ""]) {
        expect(turnMessageMetadata({ type }, cause, THREAD)).toBeUndefined();
      }
    });
  });

  test('"finish" without a reason still carries the threadId (the key passes through as undefined)', () => {
    const result = turnMessageMetadata({ type: "finish" }, null, THREAD);
    expect(result).toEqual({ threadId: THREAD });
    expect(result?.finishReason).toBeUndefined();
  });

  test("an abort's metadata never carries a finishReason (the turn did not finish)", () => {
    expect(turnMessageMetadata({ type: "abort", finishReason: "stop" }, "provider-timeout", THREAD)).toEqual({
      errorCode: "PROVIDER_TIMEOUT",
      threadId: THREAD,
    });
  });
});
