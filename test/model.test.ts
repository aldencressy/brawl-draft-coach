import { describe, expect, it } from "vitest";
import { StatsModel } from "../src/engine/model.js";
import type { StatsData } from "../src/outputs/stats.js";

const k = { overall: 100, mode: 150, map: 200, pairOverall: 150, pairMode: 150, personal: 25 };

// Brawler 1 went 10-0, all on map 100. Every level of the stats contains those same 10 games.
const stats: StatsData = {
  generatedAt: "", window: { from: "", to: "", days: 1 }, games: 10, minRank: 13, currentMaps: [100],
  maps: { 100: { name: "M", mode: "gemGrab", games: 10, brawlers: { 1: [10, 10], 2: [10, 0] } } },
  modes: { gemGrab: { games: 10, brawlers: { 1: [10, 10], 2: [10, 0] }, vs: { "1-2": [10, 10] }, with: {} } },
  overall: { games: 10, brawlers: { 1: [10, 10], 2: [10, 0] }, vs: { "1-2": [10, 10] }, with: {} },
};

describe("StatsModel", () => {
  const model = new StatsModel(stats, "gemGrab", 100, k);

  it("counts each game once across map, mode and overall", () => {
    // Only the map level sees the games; the levels above contribute their *other* games (none).
    expect(model.mapRate(1)).toBeCloseTo((10 + 200 * 0.5) / (10 + 200));
  });

  it("counts each game once across mode and overall matchups", () => {
    const expected = 0.5 + (model.modeRate(1) - 0.5) - (model.modeRate(2) - 0.5);
    expect(model.vs(1, 2).value).toBeCloseTo((10 + 150 * expected) / (10 + 150) - expected);
  });

  it("matchups are antisymmetric", () => {
    expect(model.vs(2, 1).value).toBeCloseTo(-model.vs(1, 2).value);
  });

  it("with no data, everything sits at 50% and no edges", () => {
    const empty = new StatsModel(stats, "bounty", 999, k);
    expect(empty.mapRate(3)).toBe(0.5);
    expect(empty.vs(3, 4).value).toBe(0);
    expect(empty.with(3, 4).value).toBe(0);
  });
});
