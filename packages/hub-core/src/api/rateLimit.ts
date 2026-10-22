/** Fixed-size sliding window per key (client address). In memory; idle keys are pruned. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Records a request; false when the key is already at its limit (the request is not counted). */
  hit(key: string): boolean {
    const now = this.clock();
    this.prune(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    this.hits.set(key, [...recent, now]);
    return true;
  }

  get retryAfterSec(): number {
    return Math.ceil(this.windowMs / 1000);
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
