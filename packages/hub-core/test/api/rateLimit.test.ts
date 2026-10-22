import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/api/rateLimit.js';

describe('RateLimiter', () => {
  it('allows N per window per key, then recovers', () => {
    let now = 0;
    const rl = new RateLimiter(3, 60_000, () => now);
    expect([rl.hit('a'), rl.hit('a'), rl.hit('a'), rl.hit('a')]).toEqual([true, true, true, false]);
    expect(rl.hit('b')).toBe(true);
    now += 60_000;
    expect(rl.hit('a')).toBe(true);
  });
});
