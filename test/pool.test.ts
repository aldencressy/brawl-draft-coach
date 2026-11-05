import { describe, expect, it } from "vitest";
import { addPlayer, emptyPool, priority, recordVisit, selectPlayers, trimPool } from "../src/collector/pool.js";

const HOUR = 3_600_000;

describe("pool", () => {
  it("prefers productive players and skips ones visited within the hour", () => {
    const pool = emptyPool();
    const now = 100 * HOUR;
    ["#A", "#B", "#C", "#D"].forEach((t) => addPlayer(pool, t, now));
    recordVisit(pool, "#A", now - 3 * HOUR, 5); // productive, 3h ago -> 18
    recordVisit(pool, "#B", now - 3 * HOUR, 0); // unproductive, 3h ago -> 3
    recordVisit(pool, "#C", now - 0.5 * HOUR, 9); // too recent -> 0
    // #D never visited -> 6
    expect(selectPlayers(pool, now, 10)).toEqual(["#A", "#D", "#B"]);
    expect(priority(pool.players["#C"]!, now)).toBe(0);
  });

  it("re-adding a known player only updates when they were seen", () => {
    const pool = emptyPool();
    addPlayer(pool, "#A", 10);
    recordVisit(pool, "#A", 20, 4);
    addPlayer(pool, "#A", 30);
    expect(pool.players["#A"]).toEqual({ visitedAt: 20, lastYield: 4, seenAt: 30 });
  });

  it("trims unproductive, least recently seen players first", () => {
    const pool = emptyPool();
    addPlayer(pool, "#OLD", 1);
    addPlayer(pool, "#NEW", 5);
    addPlayer(pool, "#GOOD", 0);
    recordVisit(pool, "#GOOD", 2, 3);
    expect(trimPool(pool, 2)).toBe(1);
    expect(Object.keys(pool.players).sort()).toEqual(["#GOOD", "#NEW"]);
  });
});
