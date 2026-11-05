/**
 * Spaces calls out so no more than `requestsPerSecond` start per second.
 * Callers await `wait()` before each request; concurrent callers queue in order.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private nextSlot = 0;

  constructor(
    requestsPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    if (!(requestsPerSecond > 0)) throw new Error("requestsPerSecond must be > 0");
    this.intervalMs = 1000 / requestsPerSecond;
  }

  async wait(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  /** Pushes every future slot back, e.g. after the server says we're going too fast. */
  pause(ms: number): void {
    this.nextSlot = Math.max(this.nextSlot, this.now() + ms);
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
