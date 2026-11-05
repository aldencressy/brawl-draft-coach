import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/api/rateLimiter.js";

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

describe("RateLimiter", () => {
  it("spaces requests evenly", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(4, clock.now, clock.sleep);
    for (let i = 0; i < 4; i++) await limiter.wait();
    expect(clock.sleeps).toEqual([250, 250, 250]);
  });

  it("pause delays the next request", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(10, clock.now, clock.sleep);
    await limiter.wait();
    limiter.pause(2000);
    await limiter.wait();
    expect(clock.sleeps).toEqual([2000]);
  });
});
