/**
 * @jest-environment node
 *
 * Tests for lib/api-utils helpers, particularly requireCompanyMembership
 * which was added in Phase 3 (P0-4) and had no direct unit test — the
 * route-level tests mocked it out, so a regression in the real helper
 * (e.g., inverted admin bypass) would not have been caught.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended'
import type { PrismaClient } from '@prisma/client'

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended')
  const mock = md();
  (globalThis as any).__mockPrismaApiUtils = mock
  return { __esModule: true, default: mock }
})

// Import AFTER mock
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { apiHandler, requireCompanyMembership } from '@/lib/api-utils'
import { AppError } from '@/lib/error-handling'

function getMockPrisma(): DeepMockProxy<PrismaClient> {
  return (globalThis as any).__mockPrismaApiUtils
}

beforeEach(() => {
  mockReset(getMockPrisma())
})

describe('requireCompanyMembership', () => {
  it('resolves silently when user is a member of the company', async () => {
    getMockPrisma().userCompany.findFirst.mockResolvedValue({
      userId: 1,
      companyId: 'co-a',
    } as any)

    await expect(
      requireCompanyMembership(1, 'co-a', false)
    ).resolves.toBeUndefined()

    // Verify the query was scoped correctly
    expect(getMockPrisma().userCompany.findFirst).toHaveBeenCalledWith({
      where: { userId: 1, companyId: 'co-a' },
      select: { userId: true },
    })
  })

  it('throws AppError(404, NOT_FOUND) when user is not a member', async () => {
    getMockPrisma().userCompany.findFirst.mockResolvedValue(null)

    await expect(
      requireCompanyMembership(1, 'co-other', false)
    ).rejects.toThrow(AppError)

    // Verify it's the specific not-found AppError, not some other error
    try {
      await requireCompanyMembership(1, 'co-other', false)
      fail('Expected requireCompanyMembership to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('NOT_FOUND')
      expect((err as AppError).statusCode).toBe(404)
      // The message should NOT leak the fact that the resource exists
      expect((err as AppError).message).toBe('Resource not found')
    }
  })

  it('bypasses the membership check entirely for admin users', async () => {
    // No mock setup on userCompany.findFirst — it should never be called
    await expect(
      requireCompanyMembership(1, 'co-any', true)
    ).resolves.toBeUndefined()

    expect(getMockPrisma().userCompany.findFirst).not.toHaveBeenCalled()
  })

  it('does not silently treat null companyId as a pass', async () => {
    // This tests an edge case: if somehow a null gets through TypeScript
    // at runtime, we should still hit the query (and fail).
    getMockPrisma().userCompany.findFirst.mockResolvedValue(null)

    await expect(
      requireCompanyMembership(1, null as any, false)
    ).rejects.toThrow('Resource not found')
  })

  it('performs the DB query exactly once per call', async () => {
    getMockPrisma().userCompany.findFirst.mockResolvedValue({
      userId: 5,
      companyId: 'co-b',
    } as any)

    await requireCompanyMembership(5, 'co-b', false)

    expect(getMockPrisma().userCompany.findFirst).toHaveBeenCalledTimes(1)
  })

  it('admin bypass is not affected by membership query state', async () => {
    // Even if findFirst would reject, admin bypass short-circuits before it
    getMockPrisma().userCompany.findFirst.mockRejectedValue(
      new Error('Should not be called')
    )

    await expect(
      requireCompanyMembership(1, 'co-z', true)
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// apiHandler — THE TRANSACTION-BUSY BRANCH (reconciliation Part 2, pack REV-22
// F3). The covered writers now queue on each other's prelocked rows, so a
// request can lose its transaction to a write conflict / deadlock (P2034) or to
// the interactive-transaction budget expiring (P2028). Both are "someone else
// was writing the same rows" — an operator-actionable 503, not a generic 500
// that reads as data loss. The rest of the ladder is untouched.
// ---------------------------------------------------------------------------
describe('apiHandler — Prisma P2028/P2034 -> 503 BUSY', () => {
  let errSpy: jest.SpyInstance
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  const req = () =>
    new NextRequest('http://localhost:3000/api/anything', { method: 'POST' })

  const known = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('transaction trouble', {
      code,
      clientVersion: 'test',
    })

  // P2024 joined in fix-delta FDb-3: the pool timing out under queued writers
  // is the same operator fact — someone else was writing.
  it.each(['P2028', 'P2034', 'P2024'])('maps %s to a 503 BUSY the operator can act on', async (code) => {
    const handler = apiHandler(async () => {
      throw known(code)
    })

    const res = await handler(req())

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'the system was busy with another change — try again',
      code: 'BUSY',
    })
  })

  it('leaves every OTHER known Prisma error on the generic 500', async () => {
    const handler = apiHandler(async () => {
      throw known('P2002')
    })

    const res = await handler(req())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })

  it('does not disturb the AppError rung above it', async () => {
    const handler = apiHandler(async () => {
      throw new AppError('Account pending approval', 'FORBIDDEN', 403)
    })

    const res = await handler(req())

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: 'Account pending approval',
      code: 'FORBIDDEN',
    })
  })

  it('passes a successful response straight through', async () => {
    const handler = apiHandler(async () => NextResponse.json({ ok: true }))

    const res = await handler(req())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
