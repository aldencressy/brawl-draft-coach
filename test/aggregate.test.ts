import { describe, expect, it } from "vitest";
import { addGame, emptyDay, pairKey, pruneDays } from "../src/collector/aggregate.js";
import type { RankedGame } from "../src/collector/games.js";

const game: RankedGame = {
  key: "k1",
  day: "2026-11-05",
  time: 0,
  mode: "gemGrab",
  mapId: 15000010,
  map: "Gem Fort",
  teams: [
    [3, 1, 5],
    [2, 6, 4],
  ],
  winner: 0,
  playerTags: [],
  avgRank: 15,
  ranks: [15, 15, 15, 15, 15, 15],
  owner: 0,
};

describe("addGame", () => {
  const day = emptyDay("2026-11-05");
  addGame(day, game);
  const mode = day.modes.gemGrab!;

  it("counts each brawler on the map and mode", () => {
    expect(day.games).toBe(1);
    expect(day.maps[15000010]!.brawlers[1]).toEqual([1, 1]);
    expect(day.maps[15000010]!.brawlers[2]).toEqual([1, 0]);
    expect(Object.keys(mode.brawlers)).toHaveLength(6);
  });

  it("stores each matchup once, from the lower id's side", () => {
    expect(Object.keys(mode.vs)).toHaveLength(9);
    expect(mode.vs["1-2"]).toEqual([1, 1]); // 1 (winner) vs 2
    expect(mode.vs["2-3"]).toEqual([1, 0]); // 2 (loser) vs 3
  });

  it("stores teammate pairs for both teams", () => {
    expect(Object.keys(mode.with)).toHaveLength(6);
    expect(mode.with["1-3"]).toEqual([1, 1]);
    expect(mode.with["2-6"]).toEqual([1, 0]);
  });

  it("pairKey is order-independent", () => {
    expect(pairKey(9, 2)).toBe("2-9");
  });
});

describe("pruneDays", () => {
  it("keeps the last N days including today", () => {
    const dates = ["2026-10-29", "2026-10-30", "2026-11-04", "2026-11-05"];
    expect(pruneDays(dates, "2026-11-05", 7)).toEqual({ keep: ["2026-10-30", "2026-11-04", "2026-11-05"], drop: ["2026-10-29"] });
  });
});
