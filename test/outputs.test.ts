import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BrawlerInfo, Player } from "../src/api/types.js";
import { addGame, emptyDay } from "../src/collector/aggregate.js";
import type { RankedGame } from "../src/collector/games.js";
import type { BrawlApiData } from "../src/outputs/brawlapi.js";
import { buildRoster, emptyMe, updateMe } from "../src/outputs/me.js";
import { buildStatic, nameKey, type RolesConfig } from "../src/outputs/static.js";
import { buildStats, dayWeight, resolveBrawlerChanges } from "../src/outputs/stats.js";
import { StatsModel } from "../src/engine/model.js";
import type { Weights } from "../src/engine/types.js";
import weightsJson from "../config/weights.json";
import { fixtureLog } from "./helpers.js";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const official: BrawlerInfo[] = read("fixtures/brawlers.json").items;
const now = new Date(Date.UTC(2026, 10, 5, 13));
const weights = weightsJson as unknown as Weights;

// Trim the BrawlAPI fixtures the same way fetchBrawlApi does, without the network.
function fixtureBrawlApi(): BrawlApiData {
  const modes = read("fixtures/brawlapi/gamemodes.json").list;
  const modeKey = new Map(modes.map((m: any) => [m.id, m.scHash]));
  return {
    fetchedAt: now.toISOString(),
    brawlers: read("fixtures/brawlapi/brawlers.json").list.map((b: any) => ({
      id: b.id, name: b.name, class: b.class.name, rarity: b.rarity.name, image: b.imageUrl2, gadgets: b.gadgets, starPowers: b.starPowers,
    })),
    maps: read("fixtures/brawlapi/maps.json").list.map((m: any) => ({ id: m.id, name: m.name, mode: modeKey.get(m.gameMode.id), image: m.imageUrl, disabled: false })),
    modes: modes.map((m: any) => ({ key: m.scHash, name: m.name, color: m.color, image: m.imageUrl })),
  };
}

const roles: RolesConfig = {
  fromClass: { Tank: ["tank"], Assassin: ["assassin"] },
  brawlers: { "el primo": ["wall-breaker"], Nobody: ["x"] },
};

describe("buildStatic", () => {
  const warnings: string[] = [];
  const data = buildStatic(
    official,
    fixtureBrawlApi(),
    roles,
    { brawlers: { Shelly: { gadget: "gadget 1", starPower: "Star Power 2", gears: ["Damage", "Nope"], alternatives: ["Gadget 2"], note: "test" } } },
    now,
    (m) => warnings.push(m),
  );
  const byName = (n: string) => data.brawlers.find((b) => nameKey(b.name) === nameKey(n))!;

  it("includes every official brawler, using BrawlAPI names when known", () => {
    expect(data.brawlers).toHaveLength(official.length);
    expect(byName("El Primo").name).toBe("El Primo");
    expect(byName("Newbie").class).toBe("Unknown");
    expect(warnings.some((w) => w.includes("NEWBIE"))).toBe(true);
  });

  it("combines class roles with roles.json extras", () => {
    expect(byName("El Primo").roles).toEqual(["tank", "wall-breaker"]);
    expect(byName("Mortis").roles).toEqual(["assassin"]);
    expect(warnings).toContain('roles.json: no brawler named "Nobody"');
  });

  it("resolves builds.json names to item ids and warns about typos", () => {
    const shelly = byName("Shelly");
    expect(shelly.build).toEqual({ gadget: 23000001, starPower: 23100002, gears: [62000002], alternatives: [23000002], note: "test" });
    expect(warnings).toContain('builds.json: Shelly has no gear "Nope"');
  });

  it("adds descriptions from BrawlAPI and gears and hypercharges from the official list", () => {
    const shelly = byName("Shelly");
    expect(shelly.gadgets[0]!.description).toBeTruthy();
    expect(shelly.gears.map((g) => g.name)).toContain("Damage");
    expect(shelly.hyperCharges).toHaveLength(1);
  });

  it("keeps only maps and modes used in ranked", () => {
    expect(data.maps.every((m) => m.mode !== "soloShowdown")).toBe(true);
    expect(data.maps).toHaveLength(6);
    expect(data.modes).toHaveLength(6);
  });
});

describe("buildStats", () => {
  const game = (mapId: number, mode: string, day: string, winner: 0 | 1): RankedGame => ({
    key: `${mapId}${day}`, day, time: 0, mode, mapId, map: `Map ${mapId}`, teams: [[1, 2, 3], [4, 5, 6]], winner, playerTags: [], avgRank: 15, ranks: [15, 15, 15, 15, 15, 15], owner: 0,
  });
  const d1 = emptyDay("2026-11-01");
  const d2 = emptyDay("2026-11-05");
  addGame(d1, game(100, "gemGrab", "2026-11-01", 0));
  addGame(d2, game(100, "gemGrab", "2026-11-05", 1));
  addGame(d2, game(200, "bounty", "2026-11-05", 0));
  const stats = buildStats([d2, d1], 13, now);

  it("sums days in the window", () => {
    expect(stats.games).toBe(3);
    expect(stats.window).toEqual({ from: "2026-11-01", to: "2026-11-05", days: 2 });
    expect(stats.maps[100]!.brawlers[1]).toEqual([2, 1]);
    expect(stats.modes.gemGrab!.vs["1-4"]).toEqual([2, 1]);
  });

  it("combines modes into overall", () => {
    expect(stats.overall.games).toBe(3);
    expect(stats.overall.vs["1-4"]).toEqual([3, 2]);
    expect(stats.overall.with["1-2"]).toEqual([3, 2]);
  });

  it("lists recently played maps as current, most played first", () => {
    expect(stats.currentMaps).toEqual([100, 200]);
    const later = buildStats([d1], 13, now);
    expect(later.currentMaps).toEqual([]);
  });
});

describe("buildStats weighting", () => {
  const game = (day: string, winner: 0 | 1): RankedGame => ({
    key: day + winner, day, time: 0, mode: "gemGrab", mapId: 100, map: "M", teams: [[1, 2, 3], [4, 5, 6]], winner, playerTags: [], avgRank: 15, ranks: [15, 15, 15, 15, 15, 15], owner: 0,
  });
  // Brawler 1 lost 100 games two days ago and won 100 today.
  const old = emptyDay("2026-11-03");
  const fresh = emptyDay("2026-11-05");
  for (let i = 0; i < 100; i++) {
    addGame(old, game("2026-11-03", 1));
    addGame(fresh, game("2026-11-05", 0));
  }

  it("counts newer days more", () => {
    const stats = buildStats([old, fresh], 13, now, { recencyDecay: 0.5, balanceChange: { date: null, weightBefore: 0 } });
    // 100 wins at weight 1, 100 losses at weight 0.25
    expect(stats.maps[100]!.brawlers[1]).toEqual([125, 100]);
    expect(stats.maps[100]!.games).toBe(125);
    expect(stats.games).toBe(200);
    expect(stats.effectiveGames).toBe(125);
  });

  it("drops days before a balance change", () => {
    const stats = buildStats([old, fresh], 13, now, { recencyDecay: 1, balanceChange: { date: "2026-11-04", weightBefore: 0 } });
    expect(stats.overall.brawlers[1]).toEqual([100, 100]);
    expect(stats.window).toEqual({ from: "2026-11-05", to: "2026-11-05", days: 1 });
    expect(stats.games).toBe(100);
  });

  it("can keep part of the days before a balance change", () => {
    const stats = buildStats([old, fresh], 13, now, { recencyDecay: 1, balanceChange: { date: "2026-11-04", weightBefore: 0.3 } });
    expect(stats.overall.brawlers[1]).toEqual([130, 100]);
  });

  it("without weighting, matches the raw totals", () => {
    const stats = buildStats([old, fresh], 13, now);
    expect(stats.overall.brawlers[1]).toEqual([200, 100]);
    expect(stats.effectiveGames).toBe(stats.games);
  });

  it("day weight: the change day itself counts fully", () => {
    const w = { recencyDecay: 0.85, balanceChange: { date: "2026-11-04", weightBefore: 0 } };
    expect(dayWeight("2026-11-05", "2026-11-05", w)).toBe(1);
    expect(dayWeight("2026-11-04", "2026-11-05", w)).toBeCloseTo(0.85);
    expect(dayWeight("2026-11-03", "2026-11-05", w)).toBe(0);
  });
});

describe("buildStats: a change to one brawler", () => {
  const game = (day: string, winner: 0 | 1, teams: [number[], number[]]): RankedGame => ({
    key: day + winner, day, time: 0, mode: "gemGrab", mapId: 100, map: "M", teams, winner, playerTags: [], avgRank: 15, ranks: [15, 15, 15, 15, 15, 15], owner: 0,
  });
  // Before the change brawler 1 lost all 100 games; after it, it won all 100. Brawler 7 only
  // played before, so its games are never discounted.
  const old = emptyDay("2026-11-03");
  const fresh = emptyDay("2026-11-05");
  for (let i = 0; i < 100; i++) {
    addGame(old, game("2026-11-03", 1, [[1, 2, 3], [4, 5, 7]]));
    addGame(fresh, game("2026-11-05", 0, [[1, 2, 3], [4, 5, 6]]));
  }
  const weighting = (weightBefore: number) => ({
    recencyDecay: 1,
    balanceChange: { date: null, weightBefore: 0 },
    brawlerChanges: [{ id: 1, name: "One", date: "2026-11-04", weightBefore }],
  });

  it("discounts only that brawler's older games, and its matchups and pairs", () => {
    const stats = buildStats([old, fresh], 13, now, weighting(0));
    expect(stats.overall.brawlers[1]).toEqual([100, 100]);
    expect(stats.maps[100]!.brawlers[1]).toEqual([100, 100]);
    expect(stats.overall.with["1-2"]).toEqual([100, 100]); // its pairs too
    expect(stats.overall.vs["1-4"]).toEqual([100, 100]); // and its matchups
    // Everyone else keeps every game, including the matchups they played against others.
    expect(stats.overall.brawlers[2]).toEqual([200, 100]);
    expect(stats.overall.brawlers[7]).toEqual([100, 100]);
    expect(stats.overall.with["2-3"]).toEqual([200, 100]);
    expect(stats.games).toBe(200);
    expect(stats.maps[100]!.games).toBe(200);
  });

  it("can keep part of its older games", () => {
    const stats = buildStats([old, fresh], 13, now, weighting(0.3));
    expect(stats.overall.brawlers[1]).toEqual([130, 100]);
  });

  it("measures its pick rate against the games it could have been in", () => {
    const stats = buildStats([old, fresh], 13, now, weighting(0));
    // In every game since the change; the older games it was dropped from don't count against it.
    expect(stats.exposure!.maps[100]![1]).toBe(100);
    expect(stats.exposure!.modes.gemGrab![1]).toBe(100);
    const model = new StatsModel(stats, "gemGrab", 100, weights);
    expect(model.mapShare(1)).toBe(1);
    expect(model.mapShare(2)).toBe(1);
    expect(model.mapShare(7)).toBe(0.5);
  });

  it("is left out of stats.json when there are no changes", () => {
    expect(buildStats([old, fresh], 13, now).exposure).toBeUndefined();
  });

  it("resolves names from config and reports ones it doesn't know", () => {
    const warnings: string[] = [];
    const brawlers = [{ id: 16000032, name: "Mr. P" }, { id: 16000000, name: "Shelly" }];
    const out = resolveBrawlerChanges(
      [{ brawler: "mr p", date: "2026-11-05" }, { brawler: "Mr Q", date: "2026-11-05" }, { brawler: "Shelly", date: "Nov 5" }],
      brawlers,
      (m) => warnings.push(m),
    );
    expect(out).toEqual([{ id: 16000032, name: "Mr. P", date: "2026-11-05", weightBefore: 0 }]);
    expect(warnings).toHaveLength(2);
  });
});

describe("me", () => {
  const player: Player = read("fixtures/players/9LQ0P.json");
  const log = fixtureLog(player.tag).items;

  it("records each of my ranked games once, with my side's result", () => {
    const me = emptyMe(player.tag);
    const added = updateMe(me, log, "soloRanked", 3, now);
    expect(added).toBe(log.filter((e) => e.battle.type === "soloRanked").length);
    expect(updateMe(me, log, "soloRanked", 3, now)).toBe(0);

    const first = log.find((e) => e.battle.type === "soloRanked")!;
    const mine = me.recent.find((g) => g.time === me.recent[0]!.time)!;
    expect(mine.won).toBe(first.battle.result === "victory");
    expect(mine.allies).toHaveLength(2);
    expect(mine.enemies).toHaveLength(3);

    const totalGames = Object.values(me.brawlers).reduce((n, [g]) => n + g, 0);
    expect(totalGames).toBe(added);
  });

  it("builds the roster with my rank and per-brawler record", () => {
    const me = emptyMe(player.tag);
    updateMe(me, log, "soloRanked", 3, now);
    const roster = buildRoster(player, me, now);
    expect(roster.ranked.rankName).toBe("MYTHIC III");
    expect(roster.brawlers).toHaveLength(player.brawlers.length);
    for (const b of roster.brawlers) {
      const games = me.recent.filter((g) => g.brawler === b.id);
      expect(b.games).toBe(games.length);
      expect(b.wins).toBe(games.filter((g) => g.won).length);
    }
  });
});
