// @jest-environment node
/**
 * W1-3b RIDE-ALONG B — the staging queue must not ship password hashes.
 *
 * FOUND during W1-3a: `lib/staging/queries.ts` hydrated `receivedByUser: true`,
 * which is Prisma for "every column of the User row" — passwordHash included.
 * Both staging reads return the hydrated row VERBATIM, so every pre-staging list
 * render handed the whole user row for whoever logged each box to the browser.
 * The client type only ever declared { id, username }; nothing in the UI wanted
 * the rest, and nobody noticed.
 *
 * The fix is a scoped `select`. The pin is deliberately NOT "the include object
 * has the right shape" — that would pass just as happily if a sibling relation
 * started leaking tomorrow. It is a DEEP SCAN of the actual response body for a
 * `passwordHash` key at ANY depth.
 *
 * To make that scan meaningful without a database, the mocked delegate
 * SIMULATES Prisma's include semantics: `relation: true` hands back the whole
 * row (hash and all), `relation: { select }` hands back only the selected keys.
 * The test therefore goes red against the old include and green against the new
 * one, for the same reason production did.
 */

/** The FULL user row, exactly as MySQL holds it. `mock`-prefixed so the jest
 *  factory hoist allows the reference. */
const mockFullUser = {
  id: 7,
  username: 'kris',
  email: 'kris@example.com',
  passwordHash: '$2b$10$notarealhashbutlongenoughtohurt',
  isAdmin: false,
  isApproved: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

/** Project a relation the way Prisma does, given `true` or `{ select }`. */
const mockHydrate = (spec: unknown, row: Record<string, unknown>) => {
  if (spec === true) return { ...row };
  const select = (spec as { select?: Record<string, boolean> })?.select;
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) out[field] = row[field];
  }
  return out;
};

const mockStagingRow = (include: any) => ({
  id: 5,
  description: 'Unlabeled box of vials',
  status: 'RECEIVED',
  expectedQuantity: 10,
  countedQuantity: null,
  unitCostCents: null,
  locationId: 1,
  receivedBy: 7,
  receivedAt: new Date('2026-08-01T00:00:00Z'),
  location: include?.location ? { id: 1, name: 'Main Warehouse' } : undefined,
  resolvedProduct: null,
  receivedByUser: include?.receivedByUser
    ? mockHydrate(include.receivedByUser, mockFullUser)
    : undefined,
});

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(async () => ({
      user: { id: 7, isAdmin: false, isApproved: true },
    })),
  };
});

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    stagingItem: {
      findMany: jest.fn(async ({ include }: any) => [mockStagingRow(include)]),
      findUnique: jest.fn(async ({ include }: any) => mockStagingRow(include)),
    },
  },
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

import { NextRequest } from 'next/server';
import { GET as listGET } from '@/app/api/staging-items/route';
import { GET as detailGET } from '@/app/api/staging-items/[id]/route';

/** Every key name appearing anywhere in a JSON tree. */
function deepKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      deepKeys(child, acc);
    }
  }
  return acc;
}

describe('staging reads never ship a password hash', () => {
  it('the LIST response contains no passwordHash key at any depth', async () => {
    const res = await listGET(
      new NextRequest('http://t/api/staging-items?status=RECEIVED'),
      {} as any,
    );
    const json = await res.json();

    expect(deepKeys(json)).not.toContain('passwordHash');
    // ...and the scan is not vacuous: the row it walked really did carry the user.
    expect(json.items[0].receivedByUser).toEqual({ id: 7, username: 'kris' });
  });

  it('the DETAIL response contains no passwordHash key at any depth', async () => {
    const res = await detailGET(new NextRequest('http://t/api/staging-items/5'), {
      params: { id: '5' },
    });
    const json = await res.json();

    expect(deepKeys(json)).not.toContain('passwordHash');
    expect(json.receivedByUser).toEqual({ id: 7, username: 'kris' });
  });

  it('the deep scan itself works (it finds a hash that IS present)', () => {
    expect(deepKeys({ items: [{ receivedByUser: mockFullUser }] })).toContain('passwordHash');
  });
});
