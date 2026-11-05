import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BrawlerInfo, Player } from "../src/api/types.js";
import { addGame, emptyDay } from "../src/collector/aggregate.js";
import type { RankedGame } from "../src/collector/games.js";
import type { BrawlApiData } from "../src/outputs/brawlapi.js";
import { buildRoster, emptyMe, updateMe } from "../src/outputs/me.js";
import { buildStatic, nameKey, type RolesConfig } from "../src/outputs/static.js";
import { buildStats } from "../src/outputs/stats.js";
import { fixtureLog } from "./helpers.js";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const official: BrawlerInfo[] = read("fixtures/brawlers.json").items;
const now = new Date(Date.UTC(2026, 10, 5, 13));

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
    { brawlers: { Shelly: { gadget: "gadget 1", starPower: "Star Power 2", gears: ["Damage", "Nope"], note: "test" } } },
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
    expect(shelly.build).toEqual({ gadget: 23000001, starPower: 23100002, gears: [62000002], note: "test" });
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
    key: `${mapId}${day}`, day, time: 0, mode, mapId, map: `Map ${mapId}`, teams: [[1, 2, 3], [4, 5, 6]], winner, playerTags: [], avgRank: 15,
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
