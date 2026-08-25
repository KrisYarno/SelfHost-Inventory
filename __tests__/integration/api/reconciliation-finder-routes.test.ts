/**
 * @jest-environment node
 *
 * THE TWO R-B FINDER ROUTES (reconciliation lane, pack C2c.4; spec REV-7 §5).
 *
 *   GET /api/reconciliation/exceptions -> { rows, count, moreCount, nextCursor }
 *   GET /api/reconciliation/unmapped   -> { groups, buckets, count, moreCount, nextCursor }
 *
 * The REAL producers run against a mocked Prisma, so these pins cover the HTTP
 * surface AND its seam with `lib/reconciliation/{exceptions,unmapped}.ts`: the
 * envelopes, the 400s each schema owes, the admin guard, and the fact that both
 * files are dynamic.
 *
 * The last describe is the BOUNDARY pin. `app/api/reconciliation/exceptions`
 * serves exception rows without the route ever naming the Prisma delegate —
 * that is what keeps the exceptions write boundary's GET scan green — and the
 * producer is where the delegate lives. Asserted here as well as there, because
 * a gate nobody can see failing in the milestone that could break it is a gate
 * that gets discovered late.
 */

jest.mock('@/lib/api-utils', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/api-utils'),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: true } })),
}));

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { requireAdmin } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import {
  GET as exceptionsGET,
  dynamic as exceptionsDynamic,
} from '@/app/api/reconciliation/exceptions/route';
import {
  GET as unmappedGET,
  dynamic as unmappedDynamic,
} from '@/app/api/reconciliation/unmapped/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireAdmin = requireAdmin as jest.Mock;

const REPO_ROOT = process.cwd();
const EXCEPTIONS_ROUTE = 'app/api/reconciliation/exceptions/route.ts';
const UNMAPPED_ROUTE = 'app/api/reconciliation/unmapped/route.ts';

function exceptionRow(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    key: 'recv-discrepancy:501',
    kind: 'recv-discrepancy',
    subject: { stagingItemId: 501, shipmentId: 'ship-1', countedQty: 8, expectedQty: 10, shortUnits: 2, lossCents: 1200 },
    firstSeenAt: new Date('2026-08-10T00:00:00.000Z'),
    lastSeenAt: new Date('2026-08-18T00:00:00.000Z'),
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    note: 'short by two',
    ...over,
  };
}

const UNMAPPED_ROW = {
  integrationId: 'int-1',
  externalProductId: 'P1',
  externalVariantId: null,
  integrationName: 'Acme Store',
  platform: 'WOOCOMMERCE',
  sku: 'SKU-1',
  name: 'Widget',
  itemCount: 4,
  oldest: new Date('2026-08-01T00:00:00.000Z'),
};

const UNMAPPED_TOTALS = {
  total: 1,
  unknownGroups: 0,
  bucket0: 0,
  bucket1: 1,
  bucket2: 0,
  bucket3: 0,
};

function req(url: string): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  mockReset(db);
  mockRequireAdmin.mockResolvedValue({ user: { id: 1, isAdmin: true } });
  (db.$transaction as unknown as jest.Mock).mockImplementation((arg: unknown) =>
    Promise.all(arg as Promise<unknown>[]),
  );
  (db.inventoryException.count as unknown as jest.Mock).mockResolvedValue(1);
  (db.inventoryException.findMany as unknown as jest.Mock).mockResolvedValue([exceptionRow()]);
  (db.stagingItem.findMany as unknown as jest.Mock).mockResolvedValue([]);
  (db.user.findMany as unknown as jest.Mock).mockResolvedValue([]);
  (db.$queryRaw as unknown as jest.Mock).mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes('AS total') ? [UNMAPPED_TOTALS] : [UNMAPPED_ROW],
  );
});

// ---------------------------------------------------------------------------

describe('GET /api/reconciliation/exceptions', () => {
  it('is dynamic and admin-guarded', async () => {
    expect(exceptionsDynamic).toBe('force-dynamic');
    mockRequireAdmin.mockRejectedValue(new AppError('Forbidden', 'FORBIDDEN', 403));
    const res = await exceptionsGET(req('http://localhost/api/reconciliation/exceptions'));
    expect(res.status).toBe(403);
  });

  it('serves the four-key envelope, rendered', async () => {
    const res = await exceptionsGET(req('http://localhost/api/reconciliation/exceptions'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['count', 'moreCount', 'nextCursor', 'rows']);
    expect(body.count).toBe(1);
    expect(body.moreCount).toBe(0);
    expect(body.nextCursor).toBeNull();
    expect(body.rows[0]).toMatchObject({
      id: 7,
      key: 'recv-discrepancy:501',
      kind: 'recv-discrepancy',
      severity: 'medium',
      subjectSummary: '8 counted vs 10 expected — 2 short',
      money: { cents: 1200, label: 'supplier shortage' },
      link: { href: '/receiving/ship-1?line=501', label: 'Open the order line' },
      note: 'short by two',
    });
  });

  it('passes the four filters and the bound through to the producer', async () => {
    const res = await exceptionsGET(
      req(
        'http://localhost/api/reconciliation/exceptions?kind=labeling-loss&resolved=all&severity=medium&olderThanDays=14&limit=5',
      ),
    );
    expect(res.status).toBe(200);
    const where = (db.inventoryException.count as unknown as jest.Mock).mock.calls[0][0].where;
    expect(where.kind).toBe('labeling-loss');
    expect(where.resolvedAt).toBeUndefined();
    expect(where.lastSeenAt.lte).toBeInstanceOf(Date);
    expect((db.inventoryException.findMany as unknown as jest.Mock).mock.calls[0][0].take).toBe(5);
  });

  it('400s a kind outside the closed vocabulary', async () => {
    const res = await exceptionsGET(
      req('http://localhost/api/reconciliation/exceptions?kind=made-up'),
    );
    expect(res.status).toBe(400);
  });

  it('400s a severity outside the three levels', async () => {
    const res = await exceptionsGET(
      req('http://localhost/api/reconciliation/exceptions?severity=urgent'),
    );
    expect(res.status).toBe(400);
  });

  it('400s an open/resolved value it does not understand', async () => {
    const res = await exceptionsGET(
      req('http://localhost/api/reconciliation/exceptions?resolved=maybe'),
    );
    expect(res.status).toBe(400);
  });

  it('400s a limit above 200', async () => {
    const res = await exceptionsGET(
      req('http://localhost/api/reconciliation/exceptions?limit=201'),
    );
    expect(res.status).toBe(400);
  });

  it('400s a negative age filter', async () => {
    const res = await exceptionsGET(
      req('http://localhost/api/reconciliation/exceptions?olderThanDays=-1'),
    );
    expect(res.status).toBe(400);
  });

  it('400s a cursor it did not mint', async () => {
    const res = await exceptionsGET(
      req('http://localhost/api/reconciliation/exceptions?cursor=%7Bnope'),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/reconciliation/unmapped', () => {
  it('is dynamic and admin-guarded', async () => {
    expect(unmappedDynamic).toBe('force-dynamic');
    mockRequireAdmin.mockRejectedValue(new AppError('Forbidden', 'FORBIDDEN', 403));
    const res = await unmappedGET(req('http://localhost/api/reconciliation/unmapped'));
    expect(res.status).toBe(403);
  });

  it('serves the five-key envelope with the buckets alongside the groups', async () => {
    const res = await unmappedGET(req('http://localhost/api/reconciliation/unmapped'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'buckets',
      'count',
      'groups',
      'moreCount',
      'nextCursor',
    ]);
    expect(body.buckets).toEqual({ '0-7': 0, '8-30': 1, '31-90': 0, '90+': 0, unknown: 0 });
    expect(body.count).toBe(1);
    expect(body.groups[0]).toMatchObject({
      integrationId: 'int-1',
      externalProductId: 'P1',
      externalVariantId: null,
      itemCount: 4,
      link: {
        href: '/admin/product-mappings/int-1/map?externalProductId=P1&externalVariantId=&sku=SKU-1',
        warning: 'loads the live store catalog',
      },
    });
  });

  it('passes the age filter and the bound through to the producer', async () => {
    const res = await unmappedGET(
      req('http://localhost/api/reconciliation/unmapped?olderThanDays=30&limit=2'),
    );
    expect(res.status).toBe(200);
    const page = (db.$queryRaw as unknown as jest.Mock).mock.calls
      .map((c) => c[0] as Prisma.Sql)
      .find((q) => !q.sql.includes('AS total')) as Prisma.Sql;
    expect(page.sql).toContain('oldest <= ?');
    expect(page.values[page.values.length - 1]).toBe(3);
  });

  it('400s a limit above 200', async () => {
    const res = await unmappedGET(req('http://localhost/api/reconciliation/unmapped?limit=201'));
    expect(res.status).toBe(400);
  });

  it('400s a cursor it did not mint', async () => {
    const res = await unmappedGET(req('http://localhost/api/reconciliation/unmapped?cursor=zzz'));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The boundary the exceptions route has to keep (pack R-5)
// ---------------------------------------------------------------------------

describe('the exceptions write boundary sees these routes', () => {
  const routeSource = (repoPath: string) =>
    fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8');

  it('both files are GET routes the boundary scan can slice', () => {
    // The gate splits on `export const|async function <METHOD>`; a route it
    // cannot slice is a route it cannot check.
    const re = /^export\s+(?:const|async\s+function)\s+(POST|PUT|PATCH|DELETE|GET)\b/gm;
    for (const repoPath of [EXCEPTIONS_ROUTE, UNMAPPED_ROUTE]) {
      const methods = Array.from(routeSource(repoPath).matchAll(re)).map((m) => m[1]);
      expect(methods).toEqual(['GET']);
    }
  });

  it('the exceptions route never spells the delegate — the producer owns it', () => {
    expect(routeSource(EXCEPTIONS_ROUTE)).not.toMatch(/\binventoryException\b/);
  });

  it('the producer really is where the delegate lives (the split is not vacuous)', () => {
    const producer = fs.readFileSync(
      path.join(REPO_ROOT, 'lib/reconciliation/exceptions.ts'),
      'utf8',
    );
    expect(producer).toMatch(/\binventoryException\b/);
  });
});
