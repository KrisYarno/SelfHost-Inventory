/**
 * withDeadlockRetry — QB-7: a TYPED refusal is never transient.
 *
 * ORDER_GONE's message interpolates a caller-controlled order id; an id
 * containing "deadlock" must not buy three retries (with sleeps) of a
 * deterministic 409/404. The engine-shaped retry behaviour is untouched.
 */
import { withDeadlockRetry } from '@/lib/inventory';
import { AppError } from '@/lib/error-handling';

describe('withDeadlockRetry — typed refusals (QB-7)', () => {
  it('throws an AppError ONCE even when its message names a deadlock', async () => {
    const fn = jest.fn(async () => {
      throw new AppError('order deadlock-hostile-id no longer exists', 'ORDER_GONE', 409);
    });
    await expect(withDeadlockRetry(fn)).rejects.toMatchObject({ code: 'ORDER_GONE' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries a real deadlock message the contracted three times', async () => {
    const fn = jest.fn(async () => {
      throw new Error('Deadlock found when trying to get lock; try restarting transaction');
    });
    await expect(withDeadlockRetry(fn)).rejects.toThrow(/Deadlock found/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
