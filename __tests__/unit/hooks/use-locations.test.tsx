/** @jest-environment jsdom */
/**
 * `hooks/use-locations.ts` — THE ONE HOME of the locations query (plan P-9,
 * contract pack C2c.4).
 *
 * There were TWO copies: `use-staging`'s (shape-tolerant, `enabled`-taking, no
 * abort signal) and `use-account`'s (signal-passing, strict `res.json()`), and
 * both wrote the SAME react-query key `["locations"]`. Two parsers behind one
 * cache key is a real bug and not a tidiness complaint: whichever hook mounted
 * first decided what shape the OTHER hook's consumers read out of the cache, so
 * a dialog could get a payload its own parser would have normalized.
 *
 * The merge keeps BOTH copies' useful behavior — `enabled`, the abort signal,
 * the tolerant parse, the server's error message — and these tests pin the
 * union, plus the invariant that made the merge necessary: exactly ONE module
 * owns the `["locations"]` key.
 */

import fs from 'fs';
import path from 'path';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

import { useLocations, locationKeys } from '@/hooks/use-locations';
import { labelingKeys } from '@/hooks/use-labeling-keys';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  }
  return Harness;
}

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('useLocations', () => {
  it('reads `/api/locations` under the shared key and PASSES THE ABORT SIGNAL', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [{ id: 1, name: 'Main' }] });

    const { result } = renderHook(() => useLocations(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual([{ id: 1, name: 'Main' }]));
    expect(mockFetch).toHaveBeenCalledWith('/api/locations', {
      signal: expect.any(AbortSignal),
    });
    expect(locationKeys.all).toEqual(['locations']);
  });

  it('tolerates BOTH payload shapes — a bare array and `{ locations }`', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ locations: [{ id: 2, name: 'B' }] }) });

    const { result } = renderHook(() => useLocations(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual([{ id: 2, name: 'B' }]));
  });

  it('surfaces the server\'s error message, and survives a non-JSON body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error('not json');
      },
    });

    const { result } = renderHook(() => useLocations(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('Failed to fetch locations');
  });

  it('does not fetch at all while `enabled` is false (the closed-dialog case)', async () => {
    const { result } = renderHook(() => useLocations(false), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('ONE PARSER PER KEY (the reason this hook exists)', () => {
  it('exactly one module under hooks/ owns the `["locations"]` key', () => {
    // KEY ownership, not URL ownership: `use-admin`'s `useLocationOptions`
    // reads the same endpoint under its OWN key (`["admin","location-options"]`)
    // and is therefore its own cache with its own parser — which is fine, and
    // is exactly the distinction that was broken before.
    const dir = path.join(process.cwd(), 'hooks');
    const owners = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
      .filter((file) => {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        return /\["locations"\]|locationKeys\.all/.test(source);
      });

    expect(owners).toEqual(['use-locations.ts']);
  });

  it('`use-staging` no longer exports a locations hook, not even a re-export', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'hooks', 'use-staging.ts'), 'utf8');
    expect(source).not.toMatch(/useLocations/);
  });
});

describe('labelingKeys', () => {
  it('keys the queue by order, with a stable "all" bucket', () => {
    expect(labelingKeys.all).toEqual(['labeling']);
    expect(labelingKeys.queue()).toEqual(['labeling', 'queue', 'all']);
    expect(labelingKeys.queue('ord_1')).toEqual(['labeling', 'queue', 'ord_1']);
  });
});
