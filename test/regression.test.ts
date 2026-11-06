// Regression: on a long-range Heist map the engine once suggested brawlers that are almost
// never played there (Ollie: 0 games, Bibi: 16-16), ahead of well-proven picks like Colt and
// 8-Bit. Causes: other maps' win rates carried over in full, and counter risk punished
// well-measured brawlers for noise. This rebuilds that situation with made-up numbers.
import { describe, expect, it } from "vitest";
import type { Record2 } from "../src/collector/aggregate.js";
import { recommend } from "../src/engine/recommend.js";
import type { EngineData } from "../src/engine/types.js";
import type { StaticData } from "../src/outputs/static.js";
import { NO_WEIGHTING, type PairStats, type StatsData } from "../src/outputs/stats.js";
import { draftConfig, weights } from "./engineWorld.js";

const COLT = 1, EIGHT_BIT = 2, OLLIE = 3, BIBI = 4, PIPER = 5, HARD_COUNTER = 99;
const MAP = 500;
const FILLERS = Array.from({ length: 40 }, (_, i) => 100 + i);
const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const rate = (games: number, wr: number): Record2 => [games, Math.round(games * wr)];

function build(): EngineData {
  const brawlers: Record<string, Record2> = {};
  const mapBrawlers: Record<string, Record2> = {};
  const vs: PairStats["vs"] = {};
  const set = (id: number, overall: Record2, map: Record2) => {
    brawlers[id] = overall;
    mapBrawlers[id] = map;
  };
  set(COLT, rate(7000, 0.53), rate(2200, 0.56));
  set(EIGHT_BIT, rate(4700, 0.54), rate(1450, 0.57));
  set(OLLIE, [0, 0], [0, 0]); // never played in this mode
  set(BIBI, rate(370, 0.6), rate(32, 0.5)); // good on other Heist maps, even here
  set(PIPER, rate(5000, 0.51), rate(1400, 0.5));
  set(HARD_COUNTER, rate(1500, 0.55), rate(300, 0.55)); // a decent brawler in its own right
  for (const f of FILLERS) set(f, rate(1000, 0.5), rate(150, 0.5));

  // Fair matchups with realistic sampling noise (about ±3 points at 300 games): hundreds of games
  // for Colt (popular), a handful for Ollie (rare).
  FILLERS.forEach((f, i) => {
    const noise = 0.03 * Math.sin((i + 1) * 12.9898);
    const colt = rate(300, 0.5 + noise);
    vs[key(COLT, f)] = COLT < f ? colt : [colt[0], colt[0] - colt[1]];
    vs[key(OLLIE, f)] = rate(4, 0.5);
  });
  // One real counter: beats Piper by 12 points over 1,500 games.
  vs[key(PIPER, HARD_COUNTER)] = rate(1500, 0.5 - 0.12);

  const pairs: PairStats = { games: 15000, brawlers, vs, with: {} };
  const ollieElsewhere: Record2 = rate(1300, 0.55);
  const stats: StatsData = {
    generatedAt: "", window: { from: "", to: "", days: 3 }, games: 50000, effectiveGames: 50000, weighting: NO_WEIGHTING, minRank: 13, currentMaps: [MAP],
    maps: { [MAP]: { name: "Bridge", mode: "heist", games: 3800, brawlers: mapBrawlers } },
    modes: { heist: pairs },
    overall: { ...pairs, games: 50000, brawlers: { ...brawlers, [OLLIE]: ollieElsewhere, [BIBI]: rate(2900, 0.56) } },
  };
  const ids = [COLT, EIGHT_BIT, OLLIE, BIBI, PIPER, HARD_COUNTER, ...FILLERS];
  const staticData: StaticData = {
    generatedAt: "", brawlApiFetchedAt: null, modes: [],
    maps: [{ id: MAP, name: "Bridge", mode: "heist", image: "" }],
    brawlers: ids.map((id) => ({ id, name: `B${id}`, class: "", rarity: "", image: "", roles: [], gadgets: [], starPowers: [], hyperCharges: [], gears: [] })),
  };
  return {
    stats,
    static: staticData,
    roster: {
      generatedAt: "", tag: "#ME", name: "Me", recent: [],
      ranked: { rank: 15, rankName: null, elo: null, seasonHighName: null, allTimeHighName: null },
      brawlers: [COLT, EIGHT_BIT, OLLIE, BIBI, PIPER].map((id) => ({ id, power: 11, gadgets: [], starPowers: [], hyperCharges: [], gears: [], games: 0, wins: 0 })),
    },
  };
}

describe("regression: rarely played brawlers on a long-range map", () => {
  const data = build();
  const rec = recommend({ mapId: MAP, mySlot: 1, bans: [], allies: [], enemies: [] }, data, weights, draftConfig);
  const order = rec.candidates.map((c) => c.id);
  const get = (id: number) => rec.candidates.find((c) => c.id === id)!;

  it("ranks the well-proven map picks first", () => {
    expect(order.slice(0, 2).sort()).toEqual([COLT, EIGHT_BIT]);
    expect(order.indexOf(OLLIE)).toBeGreaterThan(1);
    expect(order.indexOf(BIBI)).toBeGreaterThan(1);
  });

  it("doesn't claim map strength it hasn't seen on this map", () => {
    expect(get(OLLIE).reasons.some((r) => r.startsWith("Strong on map"))).toBe(false);
    expect(get(OLLIE).warning).toBe("Not picked on this map yet");
    expect(get(BIBI).warning).toBe("Rarely picked here (32 games)");
    expect(get(OLLIE).parts.unproven).toBeLessThan(get(COLT).parts.unproven);
  });

  it("noisy matchups alone don't make a popular brawler look easy to counter", () => {
    expect(get(COLT).parts.later).toBeGreaterThan(-2);
  });

  it("a real hard counter that the enemy would pick shows up as a likely answer", () => {
    // Pick 5: only the enemy's last pick is left. With the strong ranged picks banned, the hard
    // counter is the enemy's best option once Piper is on the board.
    const late = recommend(
      { mapId: MAP, mySlot: 5, bans: [COLT, EIGHT_BIT], allies: [FILLERS[0]!, FILLERS[1]!], enemies: [FILLERS[2]!, FILLERS[3]!] },
      data,
      weights,
      draftConfig,
    );
    const piper = late.candidates.find((c) => c.id === PIPER)!;
    expect(piper.details.threats[0]!.id).toBe(HARD_COUNTER);
    expect(piper.parts.later).toBeLessThan(-3);
    expect(piper.warning).toBe(`Likely answer: B${HARD_COUNTER}`);
  });

  it("hands the map's meta to the AI layer, most picked first", () => {
    expect(rec.data.mapMeta[0]).toMatchObject({ id: COLT, games: 2200, winRate: 0.56 });
    expect(rec.data.mapMeta.map((m) => m.id).slice(0, 3)).toEqual([COLT, EIGHT_BIT, PIPER]);
  });
});
