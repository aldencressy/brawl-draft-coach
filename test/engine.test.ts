import { describe, expect, it } from "vitest";
import { enemyPicksAfter, slotsOf, teamOfSlot } from "../src/engine/draft.js";
import { recommend } from "../src/engine/recommend.js";
import type { Draft, Weights } from "../src/engine/types.js";
import { B, BOUNTY_MAP, GEM_FORT, buildWorld, draftConfig, weights } from "./engineWorld.js";

const world = buildWorld();
const draft = (d: Partial<Draft>): Draft => ({ mapId: GEM_FORT, mySlot: 1, bans: [], allies: [], enemies: [], ...d });
const run = (d: Partial<Draft>, w: Weights = weights) => recommend(draft(d), world, w, draftConfig);
const rankOf = (rec: ReturnType<typeof run>, id: number) => rec.candidates.findIndex((c) => c.id === id);
const top = (rec: ReturnType<typeof run>) => rec.candidates[0]!;

describe("draft order", () => {
  it("follows the ranked snake draft by default", () => {
    expect([1, 2, 3, 4, 5, 6].map((s) => teamOfSlot(draftConfig.order, s))).toEqual(["first", "second", "second", "first", "first", "second"]);
    expect(slotsOf(draftConfig.order, "first")).toEqual([1, 4, 5]);
  });

  it("counts enemy picks still to come after my slot", () => {
    expect([1, 2, 3, 4, 5, 6].map((s) => enemyPicksAfter(draftConfig.order, s, 0))).toEqual([3, 2, 2, 1, 1, 0]);
    // If the enemy has already picked ahead of the order, fewer remain.
    expect(enemyPicksAfter(draftConfig.order, 1, 2)).toBe(1);
  });

  it("uses a custom order when configured", () => {
    const alternating = { order: ["first", "second", "first", "second", "first", "second"] as const };
    expect(enemyPicksAfter([...alternating.order], 3, 1)).toBe(2);
  });
});

describe("recommend: sample drafts", () => {
  it("first pick on Gem Fort: the map specialist leads, for its map strength", () => {
    const rec = run({ mySlot: 1 });
    expect(top(rec).id).toBe(B.Mapper);
    expect(top(rec).reasons[0]).toMatch(/^Strong on map/);
  });

  it("tags 'hard to counter' only when it sets a brawler apart", () => {
    const rec = run({ mySlot: 1 }, { ...weights, handOffTop: 20 });
    const safe = rec.candidates.filter((c) => (c.details.threats[0]?.low ?? 0) < weights.reasonMinPoints);
    const tagged = rec.candidates.filter((c) => c.reasons.includes("Hard to counter"));
    if (safe.length > rec.candidates.length / 2) expect(tagged).toEqual([]);
    else expect(tagged.map((c) => c.id)).toEqual(safe.map((c) => c.id));
    expect(tagged.map((c) => c.id)).not.toContain(B.Fragile);
    // Picked last, there's nothing left to counter you, so nobody gets the tag.
    const last = run({ mySlot: 6, allies: [B.Filler1, B.Tank], enemies: [B.Filler2, B.Unowned, B.Prey] });
    expect(last.candidates.some((c) => c.reasons.includes("Hard to counter"))).toBe(false);
  });

  it("first pick: a strong but easily countered brawler is held back, and warned about", () => {
    const early = run({ mySlot: 1 });
    const fragile = early.candidates.find((c) => c.id === B.Fragile)!;
    expect(fragile.parts.risk).toBeLessThan(-1.5);
    expect(fragile.warning).toBe("Watch for Bully");
    expect(fragile.details.threats[0]!.id).toBe(B.Bully);
    // Picked last there's no risk, so it ranks higher than it did first.
    const late = run({ mySlot: 6, allies: [B.Filler1, B.Tank], enemies: [B.Filler2, B.Unowned, B.Prey] });
    expect(rankOf(late, B.Fragile)).toBeLessThan(rankOf(early, B.Fragile));
  });

  it("last pick against Prey: the counter comes first", () => {
    const rec = run({ mySlot: 6, allies: [B.Filler1, B.TwinA], enemies: [B.Prey, B.Filler2, B.Tank] });
    expect(top(rec).id).toBe(B.Hunter);
    expect(top(rec).reasons).toContain("Counters Prey");
    const prey = top(rec).details.counters.find((c) => c.id === B.Prey)!;
    // Planted at +15. In a 12-brawler world Hunter meets Prey in a quarter of its games, so part
    // of the effect shows up in their own win rates instead; with ~110 brawlers that leak is small.
    expect(prey.points).toBeGreaterThan(5);
  });

  it("pick 4 with TwinA on the team: TwinB comes first, paired with TwinA", () => {
    const rec = run({ mySlot: 4, allies: [B.TwinA], enemies: [B.Filler1, B.Filler2] });
    expect(top(rec).id).toBe(B.TwinB);
    expect(top(rec).reasons).toContain("Pairs with TwinA");
  });

  it("an enemy tank boosts anti-tank through role fit", () => {
    const rec = run({ mySlot: 6, allies: [B.Filler1, B.Filler2], enemies: [B.Tank, B.Prey, B.Bully] });
    const anti = rec.candidates.find((c) => c.id === B.AntiTank)!;
    expect(anti.details.rolesAnswering).toEqual(["tank"]);
    expect(anti.reasons).toContain("Answers their tank");
    const without = run({ mySlot: 6, allies: [B.Filler1, B.Filler2], enemies: [B.Filler1 + 100, B.Prey, B.Bully] });
    expect(anti.parts.role).toBeGreaterThan(without.candidates.find((c) => c.id === B.AntiTank)!.parts.role);
  });

  it("never suggests banned, picked, unowned or under-powered brawlers", () => {
    const rec = run({ mySlot: 4, bans: [B.Mapper], allies: [B.TwinA], enemies: [B.Hunter, B.Prey] }, { ...weights, minPower: 11, handOffTop: 20 });
    const ids = rec.candidates.map((c) => c.id);
    for (const id of [B.Mapper, B.TwinA, B.Hunter, B.Prey, B.Unowned, B.Filler2]) expect(ids).not.toContain(id);
    expect(ids).toHaveLength(6);
  });

  it("still counts unowned brawlers as enemy threats", () => {
    const rec = run({ mySlot: 1 });
    const pool = new Set(rec.candidates.flatMap((c) => c.details.threats.map((t) => t.id)));
    expect(rec.candidates.map((c) => c.id)).not.toContain(B.Unowned);
    expect(pool.size).toBeGreaterThan(0);
  });
});

describe("recommend: summary tags", () => {
  it("names a general edge when no single matchup stands out", () => {
    const rec = run({ mySlot: 6, allies: [B.Filler1, B.TwinA], enemies: [B.Prey, B.Filler2, B.Tank] }, { ...weights, handOffTop: 20 });
    for (const c of rec.candidates) {
      const specific = c.reasons.some((r) => r.startsWith("Counters"));
      if (c.reasons.includes("Good into their picks")) expect(specific).toBe(false);
    }
  });
});

describe("recommend: thin data", () => {
  it("flags low data and leans on the mode rate when the map has few games", () => {
    const thin = { ...weights, lowDataGames: 100_000 };
    const rec = run({ mySlot: 1 }, thin);
    expect(rec.candidates.every((c) => c.lowData)).toBe(true);
    expect(top(rec).warning).toMatch(/^Rarely picked here \(\d+ games\)$/);
  });

  it("works for a map with no data at all, using the mode", () => {
    const rec = run({ mapId: 999, mySlot: 1 });
    expect(rec.candidates.length).toBeGreaterThan(0);
    expect(rec.data.mapGames).toBe(0);
    expect(top(rec).details.usedModeFallback).toBe(true);
  });

  it("uses each map's own mode", () => {
    expect(run({ mapId: BOUNTY_MAP }).context.mode).toBe("bounty");
  });
});

describe("recommend: output", () => {
  const rec = run({ mySlot: 5, bans: [B.Unowned], allies: [B.TwinA], enemies: [B.Prey, B.Bully] });

  it("is plain JSON, ready to hand to the AI layer", () => {
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
    expect(rec.context.allies).toEqual([{ id: B.TwinA, name: "TwinA" }]);
    expect(rec.context.enemyPicksAfterMine).toBe(1);
  });

  it("returns handOffTop candidates, best first, each with at most three reasons", () => {
    // 12 brawlers, minus 3 taken (Unowned is banned and unowned anyway), Unowned, and Filler2 (power 7).
    expect(rec.candidates).toHaveLength(Math.min(weights.handOffTop, 7));
    expect(rec.showTop).toBe(weights.showTop);
    for (let i = 1; i < rec.candidates.length; i++) expect(rec.candidates[i - 1]!.score).toBeGreaterThanOrEqual(rec.candidates[i]!.score);
    for (const c of rec.candidates) expect(c.reasons.length).toBeLessThanOrEqual(3);
  });

  it("score is the sum of its parts", () => {
    for (const c of rec.candidates) {
      const sum = Object.values(c.parts).reduce((a, b) => a + b, 0);
      expect(c.score).toBeCloseTo(sum, 0);
    }
  });

  it("includes the hand-written build by name", () => {
    const hunter = rec.candidates.find((c) => c.id === B.Hunter)!;
    expect(hunter.build).toEqual({ gadget: "Hunter Gadget", starPower: undefined, gears: [], note: "test build" });
  });
});

describe("recommend: comfort", () => {
  it("boosts brawlers you win a lot with", () => {
    const data = buildWorld();
    data.roster!.brawlers.find((b) => b.id === B.Filler1)!.games = 40;
    data.roster!.brawlers.find((b) => b.id === B.Filler1)!.wins = 32;
    const rec = recommend(draft({ mySlot: 1 }), data, weights, draftConfig);
    const filler = rec.candidates.find((c) => c.id === B.Filler1)!;
    expect(filler.parts.comfort).toBeGreaterThan(5);
    expect(filler.reasons.some((r) => r.startsWith("Your pick: 80% in 40"))).toBe(true);
  });
});

describe("recommend: speed", () => {
  it("scores a full-size roster in a few milliseconds", () => {
    // 110 brawlers with dense random stats, like the real data.
    const big = buildWorld(2_000);
    const extra = Array.from({ length: 100 }, (_, i) => 1000 + i);
    for (const id of extra) {
      big.static.brawlers.push({ ...big.static.brawlers[0]!, id, name: `X${id}`, build: undefined });
      big.roster!.brawlers.push({ ...big.roster!.brawlers[0]!, id });
      big.stats.overall.brawlers[id] = [500, 250];
      for (const other of extra) if (other > id) big.stats.overall.vs[`${id}-${other}`] = [50, 25];
    }
    const start = performance.now();
    for (let i = 0; i < 10; i++) recommend(draft({ mySlot: 4, allies: [1001], enemies: [1002, 1003] }), big, weights, draftConfig);
    expect((performance.now() - start) / 10).toBeLessThan(50);
  });
});
