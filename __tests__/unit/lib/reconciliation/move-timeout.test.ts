/**
 * @jest-environment node
 *
 * THE MOVE'S OWN CLOCK — and the OUTCOME-UNKNOWN classification — have ONE
 * owner (pack CB2.5e.4; the P2-B2.5 seam check, amended B25-FR1/F2). Two callers
 * post a move — the workbench's raw fetch and the admin hook — and M-B2.5b had
 * spelled the sentence and the abort rule in both. One spelling: the module
 * below, and a source pin that neither caller grows its own again (including the
 * unguarded `AbortSignal.timeout` call that threw BEFORE the fetch, inside the
 * try, on a browser that lacks it — and so read as a server refusal forever).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isTimeoutAbort,
  isMoveRefusal,
  moveAbortSignal,
  moveUnanswered,
  MOVE_TIMEOUT_MS,
  MOVE_UNANSWERED_SENTENCE,
} from '@/lib/reconciliation/move-timeout';

describe('isTimeoutAbort — the NAME, not the class', () => {
  it('a DOMException named TimeoutError is the abort', () => {
    expect(isTimeoutAbort(new DOMException('timeout', 'TimeoutError'))).toBe(true);
  });
  it('an object from another realm with the same name counts', () => {
    expect(isTimeoutAbort({ name: 'TimeoutError' })).toBe(true);
  });
  it('a plain AbortController abort is NOT this', () => {
    expect(isTimeoutAbort(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
  it('null, undefined and a bare Error are not this', () => {
    expect(isTimeoutAbort(null)).toBe(false);
    expect(isTimeoutAbort(undefined)).toBe(false);
    expect(isTimeoutAbort(new Error('x'))).toBe(false);
  });
});

describe('the constants', () => {
  it('60 s, and the frozen sentence for EVERY unanswered door', () => {
    expect(MOVE_TIMEOUT_MS).toBe(60_000);
    expect(MOVE_UNANSWERED_SENTENCE).toBe('The move did not answer — check the batch before trying again');
  });
});

describe('moveAbortSignal — the clock, GUARDED', () => {
  const original = AbortSignal.timeout;

  afterEach(() => {
    (AbortSignal as unknown as { timeout?: typeof original }).timeout = original;
  });

  it('returns a real AbortSignal where AbortSignal.timeout exists', () => {
    const signal = moveAbortSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it('asks for exactly MOVE_TIMEOUT_MS', () => {
    const spy = jest.spyOn(AbortSignal, 'timeout');
    moveAbortSignal();
    expect(spy).toHaveBeenCalledWith(60_000);
    spy.mockRestore();
  });

  it('returns undefined — never throws — where AbortSignal.timeout is absent', () => {
    delete (AbortSignal as unknown as { timeout?: typeof original }).timeout;
    expect(moveAbortSignal()).toBeUndefined();
  });
});

describe('isMoveRefusal — an ANSWER is a parsed body with a string code', () => {
  it('the house envelope is a refusal, 503 BUSY included (a definite rollback)', () => {
    expect(isMoveRefusal({ error: 'Another writer holds this batch', code: 'BUSY' })).toBe(true);
    expect(isMoveRefusal({ error: 'x', code: 'ALREADY_MOVED' })).toBe(true);
  });
  it('an empty body (the ingress 502 that parsed to {}) is NOT a refusal', () => {
    expect(isMoveRefusal({})).toBe(false);
  });
  it('a bare error with no code is NOT a refusal', () => {
    expect(isMoveRefusal({ error: 'x' })).toBe(false);
  });
  it('a non-string code is NOT a refusal', () => {
    expect(isMoveRefusal({ code: 5 })).toBe(false);
    expect(isMoveRefusal({ error: 'x', code: 5 })).toBe(false);
    expect(isMoveRefusal({ error: 'x', code: '' })).toBe(false);
  });
  it('null, undefined and a string are NOT refusals', () => {
    expect(isMoveRefusal(null)).toBe(false);
    expect(isMoveRefusal(undefined)).toBe(false);
    expect(isMoveRefusal('BUSY')).toBe(false);
  });
});

describe('moveUnanswered — one sentence, two codes', () => {
  it('the abort we asked for is TIMEOUT', () => {
    const envelope = moveUnanswered(new DOMException('t', 'TimeoutError'));
    expect(envelope.code).toBe('TIMEOUT');
    expect(envelope.error).toBe(MOVE_UNANSWERED_SENTENCE);
  });
  it('every other rejection is UNANSWERED — the request went out, nothing came back', () => {
    const envelope = moveUnanswered(new TypeError('Failed to fetch'));
    expect(envelope.code).toBe('UNANSWERED');
    expect(envelope.error).toBe(MOVE_UNANSWERED_SENTENCE);
  });
});

describe('ONE owner — the two callers import the module and spell nothing themselves', () => {
  const root = process.cwd();
  const callers = ['app/(app)/workbench/page.tsx', 'hooks/use-admin.ts'];
  it.each(callers)('%s imports @/lib/reconciliation/move-timeout', (rel) => {
    const src = readFileSync(join(root, rel), 'utf8');
    expect(src).toMatch(/from "@\/lib\/reconciliation\/move-timeout"/);
  });
  it.each(callers)('%s defines neither the sentence nor the abort rule locally', (rel) => {
    const src = readFileSync(join(root, rel), 'utf8');
    expect(src).not.toMatch(/const MOVE_UNANSWERED_SENTENCE\s*=/);
    expect(src).not.toMatch(/const MOVE_TIMEOUT_MS\s*=/);
    expect(src).not.toMatch(/function isTimeoutAbort/);
    expect(src).not.toMatch(/function isMoveRefusal/);
  });
  it.each(callers)('%s never calls AbortSignal.timeout directly (the guard is the module\'s)', (rel) => {
    const src = readFileSync(join(root, rel), 'utf8');
    expect(src).not.toMatch(/AbortSignal\.timeout\(/);
  });
});
