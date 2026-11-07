import { describe, expect, it } from "vitest";
import { toSampled } from "../src/collector/sample.js";
import { StatsModel } from "../src/engine/model.js";
import { fitWeights, gameParts, predict, score, type GameParts } from "../src/engine/backtest.js";
import { B, GEM_FORT, buildWorld, weights } from "./engineWorld.js";

// mulberry32, so the test is repeatable.
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("backtest", () => {
  it("recovers the weights that generated the results", () => {
    const rnd = seeded(3);
    const games: GameParts[] = Array.from({ length: 40_000 }, () => {
      const g = { map: (rnd() - 0.5) * 0.3, counter: (rnd() - 0.5) * 0.2, synergy: (rnd() - 0.5) * 0.2, rawMap: 0, y: 0 as 0 | 1 };
      // True model: map at 1x, counters at 1.5x, pairs don't matter.
      g.y = rnd() < 0.5 + g.map + 1.5 * g.counter ? 1 : 0;
      return g;
    });
    const fit = Object.fromEntries(fitWeights(games, ["map", "counter", "synergy"]).map((f) => [f.key, f]));
    expect(fit.map!.weight).toBeCloseTo(1, 0);
    expect(Math.abs(fit.counter!.weight - 1.5)).toBeLessThan(3 * fit.counter!.se);
    expect(Math.abs(fit.synergy!.weight)).toBeLessThan(3 * fit.synergy!.se);
    // The true weights predict better than the engine's 1x, and both beat a coin flip.
    const truth = score(games, (g) => predict(g, { counter: 1.5, synergy: 0 }), (g) => predict(g));
    expect(truth.diff).toBeLessThan(0);
    expect(score(games, (g) => predict(g)).loss).toBeLessThan(score(games, () => 0.5).loss);
  });

  it("reads a sampled game into its parts, the same way the engine scores a 3v3", () => {
    const world = buildWorld();
    const row = toSampled({
      key: "k", day: "2026-11-05", time: 0, mode: "gemGrab", mapId: GEM_FORT, map: "Gem Fort",
      teams: [[B.Hunter, B.TwinA, B.TwinB], [B.Prey, B.Filler1, B.Filler2]], winner: 0, playerTags: [], avgRank: 15,
      ranks: [15, 15, 15, 15, 15, 15], owner: 0,
    });
    const [g] = gameParts(world.stats, () => "gemGrab", [row], weights);
    const m = new StatsModel(world.stats, "gemGrab", GEM_FORT, weights);
    const a = [B.Hunter, B.TwinA, B.TwinB];
    const b = [B.Prey, B.Filler1, B.Filler2];
    const strength = (t: number[]) => t.reduce((s, id) => s + m.strength(id) - 0.5, 0);
    const pairs = (t: number[]) => m.with(t[0]!, t[1]!).value + m.with(t[0]!, t[2]!).value + m.with(t[1]!, t[2]!).value;
    let counter = 0;
    for (const x of a) for (const y of b) counter += (m.vs(x, y).value - m.vs(y, x).value) / 2;
    expect(g!.map).toBeCloseTo(strength(a) - strength(b), 10);
    expect(g!.counter).toBeCloseTo(counter, 10);
    expect(g!.synergy).toBeCloseTo(weights.synergyWeight * (pairs(a) - pairs(b)), 10);
    expect(g!.y).toBe(1);
    // Hunter's planted edge over Prey and the planted Twins pair put team 0 ahead.
    expect(m.vs(B.Hunter, B.Prey).value).toBeGreaterThan(0.04);
    expect(g!.synergy).toBeGreaterThan(0);
    expect(predict(g!)).toBeGreaterThan(0.5);
  });
});
