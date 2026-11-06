import { describe, expect, it } from "vitest";
import { StatsModel, cautious } from "../src/engine/model.js";
import { NO_WEIGHTING, type StatsData } from "../src/outputs/stats.js";

const k = { overall: 100, mode: 150, map: 200, personal: 50 };
const cfg = (carryover = { mode: 0.6, map: 0.4 }) => ({ smoothing: k, carryover, gamesPerDraft: 2.5 });

// Brawler 1 went 10-0, all on map 100. Every level of the stats contains those same 10 games.
const stats: StatsData = {
  generatedAt: "", window: { from: "", to: "", days: 1 }, games: 10, effectiveGames: 10, weighting: NO_WEIGHTING, minRank: 13, currentMaps: [100],
  maps: { 100: { name: "M", mode: "gemGrab", games: 10, brawlers: { 1: [10, 10], 2: [10, 0] } } },
  modes: { gemGrab: { games: 10, brawlers: { 1: [10, 10], 2: [10, 0] }, vs: { "1-2": [10, 10] }, with: {} } },
  overall: { games: 10, brawlers: { 1: [10, 10], 2: [10, 0] }, vs: { "1-2": [10, 10] }, with: {} },
};

describe("StatsModel", () => {
  const model = new StatsModel(stats, "gemGrab", 100, cfg());

  it("counts each game once across map, mode and overall", () => {
    // Only the map level sees the games; the levels above contribute their *other* games (none).
    expect(model.mapRate(1)).toBeCloseTo((10 + 200 * 0.5) / (10 + 200));
  });

  it("counts each game once across mode and overall matchups", () => {
    // All 10 games are in this mode. Counted once, 10 straight wins are weak evidence and stay
    // heavily shrunk; counted twice (mode and overall) they'd come out roughly twice as big.
    const expected = 0.5 + (model.modeRate(1) - 0.5) - (model.modeRate(2) - 0.5);
    const raw = 1 - expected;
    const edge = model.vs(1, 2);
    expect(edge.value).toBeGreaterThan(0);
    expect(edge.value).toBeLessThan(raw * 0.1);
  });

  it("keeps most of a big effect that has lots of evidence, and shrinks one that doesn't", () => {
    const big: StatsData = {
      ...stats,
      modes: { gemGrab: { games: 1, brawlers: {}, vs: {}, with: {} } },
      overall: {
        games: 1, brawlers: {}, with: {},
        // Background pairs give a realistic spread (about ±2 points); 1-2 is a +12 point counter
        // over 2,000 games, 3-4 the same +12 points over 40 games.
        vs: {
          ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`${100 + i}-${500 + i}`, [300 + (i % 7) * 200, Math.round((300 + (i % 7) * 200) * (0.5 + 0.035 * Math.sin(i)))]])),
          "1-2": [2000, 1240],
          "3-4": [40, 25],
        },
      },
    };
    const model = new StatsModel(big, "gemGrab", 100, cfg());
    expect(model.vs(1, 2).value).toBeGreaterThan(0.06); // keeps over half
    expect(model.vs(3, 4).value).toBeLessThan(0.02);
  });

  it("matchups are antisymmetric", () => {
    expect(model.vs(2, 1).value).toBeCloseTo(-model.vs(1, 2).value);
  });

  it("with no data, everything sits at 50% and no edges", () => {
    const empty = new StatsModel(stats, "bounty", 999, cfg());
    expect(empty.mapRate(3)).toBe(0.5);
    expect(empty.vs(3, 4).value).toBe(0);
    expect(empty.with(3, 4).value).toBe(0);
  });
});

describe("carry-over", () => {
  // Brawler 7: 1,000 games at 60% in another mode, none in this one.
  const elsewhere: StatsData = {
    ...stats,
    maps: { 100: { name: "M", mode: "gemGrab", games: 1000, brawlers: {} } },
    modes: { gemGrab: { games: 1000, brawlers: {}, vs: {}, with: {} }, bounty: { games: 1000, brawlers: { 7: [1000, 600] }, vs: {}, with: {} } },
    overall: { games: 2000, brawlers: { 7: [1000, 600] }, vs: {}, with: {} },
  };
  const rate = (carryover: { mode: number; map: number }) => new StatsModel(elsewhere, "gemGrab", 100, cfg(carryover)).mapRate(7);

  it("passes on only part of an edge earned elsewhere", () => {
    const full = rate({ mode: 1, map: 1 });
    const partial = rate({ mode: 0.6, map: 0.4 });
    expect(full).toBeGreaterThan(0.58);
    expect(partial).toBeGreaterThan(0.5);
    expect(partial - 0.5).toBeCloseTo((full - 0.5) * 0.6 * 0.4, 3);
  });

  it("with no carry-over, a brawler unseen here starts at 50%", () => {
    expect(rate({ mode: 0, map: 0 })).toBe(0.5);
  });
});

describe("uncertainty", () => {
  it("map win rate error shrinks with games on the map", () => {
    const busy: StatsData = { ...stats, maps: { 100: { name: "M", mode: "gemGrab", games: 4000, brawlers: { 1: [2000, 1100] } } } };
    const model = new StatsModel(busy, "gemGrab", 100, cfg());
    expect(model.mapRateError(1)).toBeLessThan(model.mapRateError(2) / 3);
  });

  it("a cautious edge is z standard errors closer to 0, never across it", () => {
    const e = new StatsModel(stats, "gemGrab", 100, cfg()).vs(1, 2);
    expect(e.value).toBeGreaterThan(0);
    expect(cautious(e, 1)).toBeCloseTo(Math.max(0, e.value - e.err));
    expect(cautious({ ...e, value: -e.value }, 1)).toBeCloseTo(-cautious(e, 1));
    expect(cautious(e, 100)).toBe(0);
  });

  it("pick rate comes from the map, or the mode when the map has few games", () => {
    const busy: StatsData = {
      ...stats,
      maps: { 100: { name: "M", mode: "gemGrab", games: 1000, brawlers: { 1: [250, 130] } }, 101: { name: "N", mode: "gemGrab", games: 50, brawlers: {} } },
      modes: { gemGrab: { games: 2000, brawlers: { 1: [400, 200] }, vs: {}, with: {} } },
    };
    expect(new StatsModel(busy, "gemGrab", 100, cfg()).pickRate(1)).toBe(0.25);
    expect(new StatsModel(busy, "gemGrab", 101, cfg()).pickRate(1)).toBe(0.2);
  });
});

describe("pair effects across modes", () => {
  // P is weak in Gem Grab (45%) but strong in Bounty (55%). A is average. Together they win
  // exactly what their strengths predict in Bounty (55%), and have no Gem Grab games together.
  const twoModes: StatsData = {
    ...stats,
    maps: { 100: { name: "M", mode: "gemGrab", games: 1000, brawlers: {} } },
    modes: {
      gemGrab: { games: 1000, brawlers: { 1: [1000, 500], 2: [1000, 450] }, vs: {}, with: {} },
      bounty: { games: 1000, brawlers: { 1: [1000, 500], 2: [1000, 550] }, vs: {}, with: { "1-2": [300, 165] } },
    },
    overall: { games: 2000, brawlers: { 1: [2000, 1000], 2: [2000, 1000] }, vs: {}, with: { "1-2": [300, 165] } },
  };

  it("carries over the effect, not the raw win rate, so a mode-specific strength isn't mistaken for synergy", () => {
    const model = new StatsModel(twoModes, "gemGrab", 100, cfg());
    expect(Math.abs(model.with(1, 2).value)).toBeLessThan(0.005);
  });
});
