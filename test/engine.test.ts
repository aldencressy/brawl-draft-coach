import { describe, expect, it } from "vitest";
import { enemyPicksAfter, slotsOf, teamOfSlot } from "../src/engine/draft.js";
import { StatsModel } from "../src/engine/model.js";
import { banHints } from "../src/engine/bans.js";
import { playOut, recommend } from "../src/engine/recommend.js";
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

  it("tags 'hard to answer' (or 'good into the meta') only when the rest of the draft goes well for it", () => {
    const tag = (c: ReturnType<typeof top>) => c.reasons.find((r) => r === "Hard to answer" || r === "Good into the meta");
    // Lots of reasons per brawler, so a tag earned isn't crowded out of the top three.
    const rec = run({ mySlot: 1 }, { ...weights, handOffTop: 20, reasonMinPoints: 0.5 });
    for (const c of rec.candidates) {
      if (tag(c)) expect(c.parts.later).toBeGreaterThanOrEqual(0.5);
      if (c.parts.later < 0.5) expect(tag(c)).toBeUndefined();
    }
    expect(tag(rec.candidates.find((c) => c.id === B.Fragile)!)).toBeUndefined();
    // Picked last, there's nothing left to answer you, so nobody gets the tag.
    const last = run({ mySlot: 6, allies: [B.Filler1, B.Tank], enemies: [B.Filler2, B.Unowned, B.Prey] }, { ...weights, handOffTop: 20 });
    expect(last.candidates.some((c) => tag(c))).toBe(false);
  });

  it("first pick: a strong but easily countered brawler is held back, and warned about", () => {
    const early = run({ mySlot: 1 });
    const fragile = early.candidates.find((c) => c.id === B.Fragile)!;
    // Picked first, the enemy answers it with Bully.
    expect(fragile.details.threats[0]!.id).toBe(B.Bully);
    expect(fragile.parts.later).toBeLessThan(-1.5);
    expect(fragile.warning).toMatch(/^Likely answers?: .*Bully/);
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
    expect(prey.points).toBeGreaterThan(4);
  });

  it("pick 4 with TwinA on the team: TwinB comes first, paired with TwinA", () => {
    // Pairs at full weight: this world plants a big pair effect, and the test is that the engine finds
    // it. (On real data pairs count half, see synergyWeight.)
    const rec = run({ mySlot: 4, allies: [B.TwinA], enemies: [B.Filler1, B.Filler2] }, { ...weights, synergyWeight: 1 });
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

describe("recommend: one measure at every slot", () => {
  it("a last pick's score is its own effect on the real 3v3", () => {
    const rec = run({ mySlot: 6, allies: [B.TwinA, B.Tank], enemies: [B.Prey, B.Bully, B.Filler2] }, { ...weights, handOffTop: 20 });
    for (const c of rec.candidates) {
      expect(c.parts.later).toBe(0); // nothing left to predict
      const counters = c.details.counters.reduce((t, x) => t + x.points, 0);
      const pairs = c.details.synergies.reduce((t, x) => t + x.points, 0);
      expect(c.parts.counter).toBeCloseTo(counters, 0);
      expect(c.parts.synergy).toBeCloseTo(weights.synergyWeight * pairs, 0);
    }
  });

  it("earlier picks include the enemy's likely answers and your likely teammates", () => {
    const rec = run({ mySlot: 1 });
    for (const c of rec.candidates) {
      expect(c.details.threats).toHaveLength(3);
      expect(c.details.likelyTeammates).toHaveLength(2);
      expect(c.details.threats.map((t) => t.id)).not.toContain(c.id);
    }
  });
});

describe("recommend: the meta", () => {
  const withFocus = (answerFocus: number): Weights => ({ ...weights, handOffTop: 20, simulation: { ...weights.simulation, answerFocus } });
  const find = (rec: ReturnType<typeof run>, id: number) => rec.candidates.find((c) => c.id === id)!;

  it("enemy picks still to come start from what's popular here and lean toward what suits the board", () => {
    const model = new StatsModel(world.stats, "gemGrab", GEM_FORT, weights);
    const pool = [B.Bully, B.Prey, B.Tank, B.Filler1, B.Filler2, B.Unowned];
    const prior = (b: number) => model.pickRate(b);
    const odds = (focus: number) => new Map(playOut(model, [B.Fragile], [], ["enemy"], pool, { prior, focus }).enemyOdds[0]);
    const blind = odds(0);
    expect([...blind.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // Without regard to the board, odds follow pick rates.
    const total = pool.reduce((t, b) => t + prior(b), 0);
    for (const b of pool) expect(blind.get(b)).toBeCloseTo(prior(b) / total);
    // The more enemies counter-pick, the likelier Bully, which beats Fragile.
    expect(odds(30).get(B.Bully)!).toBeGreaterThan(blind.get(B.Bully)!);
    expect(odds(300).get(B.Bully)!).toBeGreaterThan(odds(30).get(B.Bully)!);
    // Only enemy picks get odds.
    expect(playOut(model, [B.Fragile], [], ["ally", "enemy"], pool, { prior, focus: 30 }).enemyOdds).toHaveLength(1);
  });

  it("the likelier enemies are to counter-pick, the more an easily answered first pick costs", () => {
    const later = (focus: number) => find(run({ mySlot: 1 }, withFocus(focus)), B.Fragile).parts.later;
    expect(later(300)).toBeLessThan(later(0));
  });

  it("early picks gain for beating what's popular on the map", () => {
    const popular = buildWorld();
    const prey = popular.stats.maps[GEM_FORT]!.brawlers[B.Prey]!;
    popular.stats.maps[GEM_FORT]!.brawlers[B.Prey] = [prey[0] * 3, prey[1] * 3];
    const before = find(run({ mySlot: 1 }, withFocus(30)), B.Hunter);
    const after = find(recommend(draft({ mySlot: 1 }), popular, withFocus(30), draftConfig), B.Hunter);
    expect(after.details.intoMeta).toBeGreaterThan(before.details.intoMeta);
    expect(after.parts.later).toBeGreaterThan(before.parts.later);
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
    expect(hunter.build).toEqual({ gadget: "Hunter Gadget", starPower: undefined, gears: [], alternatives: [], note: "test build" });
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

describe("ban hints", () => {
  const hints = (d: Partial<Draft>) => {
    const rec = run(d);
    return { rec, hints: banHints(draft(d), world, weights, draftConfig, rec) };
  };

  it("first pick: banning the enemy's answer to a brawler lifts it", () => {
    const { rec, hints: h } = hints({ mySlot: 1 });
    // Bully is the answer that holds Fragile back; banning it brings Fragile up.
    const bully = h.chips.find((c) => c.id === B.Bully);
    expect(bully?.rises.id).toBe(B.Fragile);
    const banned = run({ mySlot: 1, bans: [B.Bully] });
    expect(rankOf(banned, B.Fragile)).toBeLessThan(rankOf(rec, B.Fragile));
    expect(rankOf(banned, B.Fragile) + 1).toBe(bully!.rises.rank);
  });

  it("says what comes first if the top suggestion is banned", () => {
    const { rec, hints: h } = hints({ mySlot: 1 });
    expect(h.ifTopBanned?.id).toBe(top(run({ mySlot: 1, bans: [top(rec).id] })).id);
    expect(h.ifTopBanned?.id).not.toBe(top(rec).id);
  });

  it("only offers bans that bring a real gain, never the top suggestion itself", () => {
    const { rec, hints: h } = hints({ mySlot: 1 });
    for (const c of h.chips) {
      expect(c.id).not.toBe(top(rec).id);
      const after = run({ mySlot: 1, bans: [c.id] });
      const riser = after.candidates[c.rises.rank - 1]!;
      expect(riser.id).toBe(c.rises.id);
      if (c.rises.rank > 1) expect(riser.score - rec.candidates.find((x) => x.id === riser.id)!.score).toBeGreaterThanOrEqual(weights.reasonMinPoints);
    }
  });

  it("offers nothing at the last pick, where bans can't change the answer", () => {
    const h = hints({ mySlot: 6, allies: [B.Filler1, B.Tank], enemies: [B.Filler2, B.Unowned, B.Prey] }).hints;
    expect(h).toEqual({ chips: [] });
  });
});
