/**
 * @jest-environment node
 */

/**
 * `pushOrderStatusToExternal` — the thin adapter onto the chokepoint.
 *
 * LANE 6 REWRITE. This function used to resolve credentials and call
 * `adapter.updateOrderStatus(storeUrl, credentials, id, status)` directly, with
 * NO internal gate — the `fulfillmentPushEnabled` check lived only in its two
 * callers, and nothing asserted it.
 *
 * It now delegates to `egress.pushOrderStatus`, which owns the gate. So this
 * suite tests exactly one thing: that the delegation is faithful and that every
 * EgressResult is mapped to an honest caller-facing shape — in particular that a
 * BLOCKED push is never reported as a success.
 *
 * The gate ITSELF (master switch, capability allowlist, integration flag,
 * credential, kill switch, retry policy, path templates) is tested in
 * __tests__/unit/lib/platforms/egress-gates.test.ts.
 */

import { pushOrderStatus } from '@/lib/platforms/egress';

jest.mock('@/lib/platforms/egress', () => ({
  __esModule: true,
  pushOrderStatus: jest.fn(),
}));

import { pushOrderStatusToExternal } from '@/lib/external-orders/shared';

const mockPushOrderStatus = pushOrderStatus as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('delegation', () => {
  it('routes the push through egress.pushOrderStatus', async () => {
    mockPushOrderStatus.mockResolvedValue({
      status: 'sent',
      httpStatus: 200,
      body: {},
    });

    const result = await pushOrderStatusToExternal(
      'int-1',
      'ext-order-123',
      'completed'
    );

    expect(mockPushOrderStatus).toHaveBeenCalledWith(
      'int-1',
      'ext-order-123',
      'completed'
    );
    expect(result.success).toBe(true);
  });

  it('passes "processing" through on a partial fulfillment (Amendment 7)', async () => {
    mockPushOrderStatus.mockResolvedValue({
      status: 'sent',
      httpStatus: 200,
      body: {},
    });

    await pushOrderStatusToExternal('int-1', 'ext-order-123', 'processing');

    expect(mockPushOrderStatus).toHaveBeenCalledWith(
      'int-1',
      'ext-order-123',
      'processing'
    );
  });

  it('takes NO credentials and NO store URL — it cannot address a store', async () => {
    // The old signature reached the network via (storeUrl, credentials). If this
    // function ever regains either, the chokepoint has been bypassed.
    expect(pushOrderStatusToExternal).toHaveLength(3);
  });
});

describe('result mapping — a blocked push is NEVER a success', () => {
  it.each([
    ['master_off'],
    ['capability_not_allowed'],
    ['integration_flag_off'],
    ['no_write_credential'],
    ['kill_switch'],
    ['invalid_env'],
    ['integration_inactive'],
    ['wrong_platform'],
    ['invalid_target'],
    ['config_changed'],
  ])('maps blocked(%s) to success:false with the named reason', async (reason) => {
    mockPushOrderStatus.mockResolvedValue({ status: 'blocked', reason });

    const result = await pushOrderStatusToExternal('int-1', 'ext-1', 'completed');

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe(reason);
    expect(result.error).toContain(reason);
  });

  it('maps dry_run to success:false (nothing was sent)', async () => {
    mockPushOrderStatus.mockResolvedValue({
      status: 'dry_run',
      wouldSend: {
        method: 'PUT',
        url: 'https://store.test/wp-json/wc/v3/orders/9',
        body: { status: 'completed' },
      },
    });

    const result = await pushOrderStatusToExternal('int-1', 'ext-1', 'completed');

    // A dry run must never look like a completed push.
    expect(result.success).toBe(false);
    expect(result.error).toContain('dry run');
  });

  it('maps a transport failure to success:false', async () => {
    mockPushOrderStatus.mockResolvedValue({
      status: 'failed',
      reason: 'transport',
    });

    const result = await pushOrderStatusToExternal('int-1', 'ext-1', 'completed');

    expect(result.success).toBe(false);
    expect(result.error).toContain('transport');
  });

  it('maps an http_error to success:false and surfaces the status', async () => {
    mockPushOrderStatus.mockResolvedValue({
      status: 'failed',
      reason: 'http_error',
      httpStatus: 401,
    });

    const result = await pushOrderStatusToExternal('int-1', 'ext-1', 'completed');

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('maps outcome_unknown to success:false — we do NOT know the store applied it', async () => {
    mockPushOrderStatus.mockResolvedValue({
      status: 'failed',
      reason: 'outcome_unknown',
    });

    const result = await pushOrderStatusToExternal('int-1', 'ext-1', 'completed');

    expect(result.success).toBe(false);
    expect(result.error).toContain('outcome_unknown');
  });

  it('ONLY status:"sent" is a success', async () => {
    mockPushOrderStatus.mockResolvedValue({
      status: 'sent',
      httpStatus: 200,
      body: {},
    });
    expect(
      (await pushOrderStatusToExternal('int-1', 'ext-1', 'completed')).success
    ).toBe(true);
  });
});
