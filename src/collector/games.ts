import { createHash } from "node:crypto";
import type { BattleLogEntry } from "../api/types.js";

/** One ranked draft game, normalized so it looks the same from every player's log. */
export interface RankedGame {
  key: string;
  /** UTC date, "YYYY-MM-DD". */
  day: string;
  time: number;
  mode: string;
  mapId: number;
  map: string;
  /** Brawler ids, in the order the API lists them (which may be the pick order: unconfirmed); teams[winner] won. */
  teams: [number[], number[]];
  winner: 0 | 1;
  playerTags: string[];
  avgRank: number;
  /** Each player's rank, in the same order as `teams` (team 0 then team 1). */
  ranks: number[];
  /** Where the log owner sits in that order (0-5). Tells us whether the order depends on whose log it is. */
  owner: number;
}

export function parseBattleTime(s: string): number {
  // "20261105T185821.000Z"
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : NaN;
}

/**
 * Turns a battle log entry into a RankedGame, or null if it isn't a usable ranked draft game.
 * `ownerTag` is whose log this came from; `result` is from their side.
 */
export function toRankedGame(entry: BattleLogEntry, ownerTag: string, rankedType: string): RankedGame | null {
  const { battle, event } = entry;
  if (battle.type !== rankedType) return null;
  const teams = battle.teams;
  if (!teams || teams.length !== 2 || teams.some((t) => t.length !== 3)) return null;
  if (battle.result !== "victory" && battle.result !== "defeat") return null;
  const mode = battle.mode ?? event.mode;
  if (!mode || !event.map || !event.id) return null;
  const time = parseBattleTime(entry.battleTime);
  if (!Number.isFinite(time)) return null;

  const ownerTeam = teams.findIndex((t) => t.some((p) => p.tag === ownerTag));
  if (ownerTeam < 0) return null;
  const ownerIndex = teams[ownerTeam]!.findIndex((p) => p.tag === ownerTag);
  const winner = (battle.result === "victory" ? ownerTeam : 1 - ownerTeam) as 0 | 1;

  const everyone = teams.flat();
  const playerTags = everyone.map((p) => p.tag).sort();
  const ranks = everyone.map((p) => p.brawler.trophies ?? 0);

  return {
    key: gameKey(entry.battleTime, playerTags),
    day: new Date(time).toISOString().slice(0, 10),
    time,
    mode,
    mapId: event.id,
    map: event.map,
    teams: [teams[0]!.map((p) => p.brawler.id), teams[1]!.map((p) => p.brawler.id)],
    winner,
    playerTags,
    avgRank: ranks.reduce((a, b) => a + b, 0) / ranks.length,
    ranks,
    owner: ownerTeam * 3 + ownerIndex,
  };
}

/** Same game in any of the six players' logs gives the same key. Hashed to keep the seen-set small. */
export function gameKey(battleTime: string, sortedTags: string[]): string {
  return createHash("sha1").update(`${battleTime}|${sortedTags.join(",")}`).digest("base64url").slice(0, 12);
}
