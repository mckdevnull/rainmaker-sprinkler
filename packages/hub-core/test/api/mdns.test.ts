import { describe, expect, it, vi } from 'vitest';
import { advertise, type BonjourLike } from '../../src/api/mdns.js';

function fakeBonjour() {
  const fake = {
    publish: vi.fn(() => ({ on: vi.fn() })),
    unpublishAll: vi.fn((cb?: () => void) => cb?.()),
    destroy: vi.fn((cb?: () => void) => cb?.()),
  };
  return fake;
}

describe('mDNS', () => {
  it('advertises _rainmaker._tcp on the API port with TXT v=1, and unpublishes on stop', async () => {
    const fake = fakeBonjour();
    const ad = advertise(8787, { factory: () => fake as unknown as BonjourLike, logger: { error: vi.fn() } });
    expect(fake.publish).toHaveBeenCalledWith({ name: 'Rainmaker', type: 'rainmaker', port: 8787, txt: { v: '1' } });
    await ad.stop();
    expect(fake.unpublishAll).toHaveBeenCalled();
    expect(fake.destroy).toHaveBeenCalled();
  });

  it('logs and carries on when publishing throws', async () => {
    const logger = { error: vi.fn() };
    const ad = advertise(8787, {
      factory: () => {
        throw new Error('no multicast');
      },
      logger,
    });
    expect(logger.error).toHaveBeenCalled();
    await expect(ad.stop()).resolves.toBeUndefined();
  });
});
