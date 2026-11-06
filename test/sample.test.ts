import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RankedGame } from "../src/collector/games.js";
import { emptyPool } from "../src/collector/pool.js";
import { SAMPLE_FIELDS, emptySample, fromSampled, offerGame, toSampled } from "../src/collector/sample.js";
import { loadState, saveState, type CollectorState } from "../src/collector/state.js";

const game = (i: number): RankedGame => ({
  key: `k${i}`, day: "2026-11-05", time: Date.UTC(2026, 10, 5, 12) + i * 1000, mode: "gemGrab", mapId: 15000010, map: "Gem Fort",
  teams: [[3, 1, 5], [2, 6, 4]], winner: 1, playerTags: [], avgRank: 15, ranks: [14, 15, 16, 17, 18, 19], owner: 4,
});

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

describe("game sample", () => {
  it("stores each game compactly, keeping the API's order, the owner's spot and every rank", () => {
    const row = toSampled(game(0));
    expect(row).toHaveLength(SAMPLE_FIELDS.length);
    expect(fromSampled(row)).toEqual({
      time: Date.UTC(2026, 10, 5, 12), mapId: 15000010, winner: 1, teams: [[3, 1, 5], [2, 6, 4]], owner: 4, ranks: [14, 15, 16, 17, 18, 19],
    });
  });

  it("keeps every game until the cap", () => {
    const sample = emptySample("2026-11-05");
    for (let i = 0; i < 10; i++) offerGame(sample, game(i), 20, Math.random);
    expect(sample.games).toHaveLength(10);
    expect(sample.seen).toBe(10);
  });

  it("past the cap, keeps a uniform sample of the whole day", () => {
    const random = seeded(7);
    let early = 0;
    const runs = 200;
    for (let r = 0; r < runs; r++) {
      const sample = emptySample("2026-11-05");
      for (let i = 0; i < 1000; i++) offerGame(sample, game(i), 50, random);
      expect(sample.games).toHaveLength(50);
      expect(sample.seen).toBe(1000);
      early += sample.games.filter((row) => fromSampled(row).time < Date.UTC(2026, 10, 5, 12) + 500_000).length;
    }
    // Half the day's games came in the first half, so about half the sample should too.
    expect(early / (runs * 50)).toBeGreaterThan(0.47);
    expect(early / (runs * 50)).toBeLessThan(0.53);
  });

  it("is saved to games/<date>.json and read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "sample-test-"));
    try {
      const sample = emptySample("2026-11-05");
      offerGame(sample, game(0), 10, Math.random);
      const state: CollectorState = { pool: emptyPool(), seen: {}, days: new Map(), samples: new Map([[sample.date, sample]]), runs: [] };
      saveState(dir, state);
      expect(readdirSync(join(dir, "games"))).toEqual(["2026-11-05.json"]);
      expect(loadState(dir).samples.get("2026-11-05")).toEqual(sample);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
