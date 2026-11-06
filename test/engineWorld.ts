// A small made-up world with known effects, played out through the real aggregation code,
// so the engine tests check it recovers effects from data rather than from hand-set numbers.
import { addGame, emptyDay } from "../src/collector/aggregate.js";
import type { RankedGame } from "../src/collector/games.js";
import type { RosterData } from "../src/outputs/me.js";
import type { StaticData } from "../src/outputs/static.js";
import { buildStats } from "../src/outputs/stats.js";
import type { DraftConfig, EngineData, Weights } from "../src/engine/types.js";
import weightsJson from "../config/weights.json";
import draftJson from "../config/draft.json";

export const weights = weightsJson as unknown as Weights;
export const draftConfig = draftJson as unknown as DraftConfig;

export const B = {
  Mapper: 1, // +8 points on Gem Fort only
  Hunter: 2, // +15 points against Prey
  Prey: 3,
  TwinA: 4, // +12 points when with TwinB
  TwinB: 5,
  Fragile: 6, // +5 points on Gem Fort, but Bully beats it by 15
  Bully: 7,
  Tank: 8,
  AntiTank: 9,
  Filler1: 10,
  Filler2: 11,
  Unowned: 12,
} as const;
export const GEM_FORT = 100;
export const OTHER_GEM_MAP = 200;
export const BOUNTY_MAP = 300;
const NAMES = Object.fromEntries(Object.entries(B).map(([name, id]) => [id, name]));

// Like real data, every pair has a small effect of its own (about ±2 points, as measured on real
// data), with the planted effects below standing out from that background.
const background = (a: number, b: number) => 0.04 * Math.sin(Math.min(a, b) * 12.9898 + Math.max(a, b) * 78.233);

function effect(team: number[], enemy: number[], mapId: number): number {
  let e = 0;
  for (const a of team) {
    for (const b of enemy) e += (a < b ? 1 : -1) * background(a, b) / 2; // halved: both sides add it
    for (const b of team) if (a < b) e += background(a + 100, b + 100) / 2;
  }
  for (const id of team) {
    if (id === B.Mapper && mapId === GEM_FORT) e += 0.08;
    if (id === B.Fragile && mapId === GEM_FORT) e += 0.05;
    if (id === B.Hunter && enemy.includes(B.Prey)) e += 0.15;
    if (id === B.Bully && enemy.includes(B.Fragile)) e += 0.15;
  }
  if (team.includes(B.TwinA) && team.includes(B.TwinB)) e += 0.12;
  return e;
}

export function buildWorld(games = 20_000, seed = 42): EngineData {
  // mulberry32: small seeded PRNG that stays within 32-bit integer math.
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T>(xs: T[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const ids = Object.values(B);
  const day = emptyDay("2026-11-05");
  // 60% Gem Fort, 38% another Gem Grab map, 2% Bounty (so Bounty's map data is thin).
  const maps: Array<[number, string, number]> = [[GEM_FORT, "gemGrab", 0.6], [OTHER_GEM_MAP, "gemGrab", 0.98], [BOUNTY_MAP, "bounty", 1]];

  for (let g = 0; g < games; g++) {
    const six = shuffle(ids).slice(0, 6);
    const teams: [number[], number[]] = [six.slice(0, 3), six.slice(3)];
    const r = rnd();
    const [mapId, mode] = maps.find(([, , cut]) => r < cut)!;
    const p = 0.5 + effect(teams[0], teams[1], mapId) - effect(teams[1], teams[0], mapId);
    const game: RankedGame = {
      key: String(g), day: day.date, time: 0, mode, mapId, map: `Map ${mapId}`,
      teams, winner: rnd() < p ? 0 : 1, playerTags: [], avgRank: 15,
    };
    addGame(day, game);
  }

  const staticData: StaticData = {
    generatedAt: "", brawlApiFetchedAt: null,
    brawlers: ids.map((id) => ({
      id, name: NAMES[id]!, class: "Test", rarity: "", image: "",
      roles: id === B.Tank ? ["tank"] : id === B.AntiTank ? ["anti-tank"] : ["damage"],
      gadgets: [{ id: id * 100 + 1, name: `${NAMES[id]} Gadget` }], starPowers: [], hyperCharges: [], gears: [],
      build: id === B.Hunter ? { gadget: id * 100 + 1, gears: [], note: "test build" } : undefined,
    })),
    maps: [
      { id: GEM_FORT, name: "Gem Fort", mode: "gemGrab", image: "" },
      { id: OTHER_GEM_MAP, name: "Other Gem Map", mode: "gemGrab", image: "" },
      { id: BOUNTY_MAP, name: "Bounty Map", mode: "bounty", image: "" },
    ],
    modes: [],
  };
  const roster: RosterData = {
    generatedAt: "", tag: "#ME", name: "Me",
    ranked: { rank: 15, rankName: "MYTHIC III", elo: null, seasonHighName: null, allTimeHighName: null },
    brawlers: ids.filter((id) => id !== B.Unowned).map((id) => ({
      id, power: id === B.Filler2 ? 7 : 11, gadgets: [], starPowers: [], hyperCharges: [], gears: [], games: 0, wins: 0,
    })),
    recent: [],
  };
  return { stats: buildStats([day], 13, new Date("2026-11-05T13:00:00Z")), static: staticData, roster };
}
