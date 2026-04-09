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
import { requireCompanyMembership } from '@/lib/api-utils'
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
