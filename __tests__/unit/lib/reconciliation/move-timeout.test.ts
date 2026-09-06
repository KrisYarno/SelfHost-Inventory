/**
 * @jest-environment node
 *
 * THE MOVE'S OWN CLOCK has ONE owner (pack CB2.5e.4; the P2-B2.5 seam check).
 * Two callers post a move — the workbench's raw fetch and the admin hook — and
 * M-B2.5b had spelled the sentence and the abort rule in both. One spelling:
 * the module below, and a source pin that neither caller grows its own again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTimeoutAbort, MOVE_TIMEOUT_MS, MOVE_TIMEOUT_SENTENCE } from '@/lib/reconciliation/move-timeout';

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
  it('60 s, and the frozen sentence', () => {
    expect(MOVE_TIMEOUT_MS).toBe(60_000);
    expect(MOVE_TIMEOUT_SENTENCE).toBe('The move did not answer in time — check the batch before trying again');
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
    expect(src).not.toMatch(/const MOVE_TIMEOUT_SENTENCE\s*=/);
    expect(src).not.toMatch(/const MOVE_TIMEOUT_MS\s*=/);
    expect(src).not.toMatch(/function isTimeoutAbort/);
  });
});
