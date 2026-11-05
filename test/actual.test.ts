import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActualApiAdapter } from '../src/actual.js';

const sdk = vi.hoisted(() => ({
  getAccountBalance: vi.fn<(id: string, cutoff?: Date) => Promise<number>>(),
}));
vi.mock('../src/actual-sdk.js', () => ({ loadActualApi: async () => sdk }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const adapter = new ActualApiAdapter({
  serverURL: 'http://unused',
  password: 'unused',
  syncId: 'unused',
  dataDir: '/unused',
});
describe('Actual balance cutoff', () => {
  it.each([
    ['2026-11-05T20:59:00Z', 5],
    ['2026-11-05T21:01:00Z', 6],
  ])('includes the current Riyadh calendar day at %s', async (instant, day) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    sdk.getAccountBalance.mockResolvedValue(12345);
    expect(await adapter.accountBalance('checking')).toBe(12345);
    const cutoff = sdk.getAccountBalance.mock.calls[0]?.[1];
    expect(cutoff).toBeInstanceOf(Date);
    // The SDK's cutoff reads host-local date fields, not the Date's UTC day.
    expect([cutoff?.getFullYear(), cutoff?.getMonth(), cutoff?.getDate()]).toEqual([2026, 10, day]);
  });
  it('uses the overview snapshot date even if the clock advances before the balance is read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T21:01:00Z'));
    sdk.getAccountBalance.mockResolvedValue(12345);
    await adapter.accountBalance('checking', '2026-11-06');
    const cutoff = sdk.getAccountBalance.mock.calls[0]?.[1];
    expect([cutoff?.getFullYear(), cutoff?.getMonth(), cutoff?.getDate()]).toEqual([2026, 10, 6]);
  });
});
