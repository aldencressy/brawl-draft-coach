// Your own ranked history and roster. Unlike the global stats, your history isn't limited to
// the 7-day window: it builds up for as long as the collector runs, for comfort picks.
import type { Record2 } from "../collector/aggregate.js";
import { toRankedGame } from "../collector/games.js";
import type { BattleLogEntry, Player } from "../api/types.js";

export interface MyGame {
  time: number;
  mode: string;
  mapId: number;
  map: string;
  brawler: number;
  won: boolean;
  rank: number;
  allies: number[];
  enemies: number[];
}

export interface MeState {
  tag: string;
  seen: Record<string, string[]>;
  /** brawlerId -> [games, wins] across all of your ranked games we've seen. */
  brawlers: Record<string, Record2>;
  /** Newest first. */
  recent: MyGame[];
}

const MAX_RECENT = 300;

export function emptyMe(tag: string): MeState {
  return { tag, seen: {}, brawlers: {}, recent: [] };
}

/** Adds your new ranked games from your battle log. Returns how many were new. */
export function updateMe(me: MeState, log: BattleLogEntry[], rankedType: string, seenKeyDays: number, now: Date): number {
  const seen = new Set(Object.values(me.seen).flat());
  const cutoff = new Date(now.getTime() - (seenKeyDays - 1) * 86_400_000).toISOString().slice(0, 10);
  let added = 0;

  for (const entry of log) {
    const game = toRankedGame(entry, me.tag, rankedType);
    if (!game || game.day < cutoff || seen.has(game.key)) continue;
    const myTeam = entry.battle.teams!.findIndex((t) => t.some((p) => p.tag === me.tag));
    const self = entry.battle.teams![myTeam]!.find((p) => p.tag === me.tag)!;
    const won = game.winner === myTeam;

    seen.add(game.key);
    (me.seen[game.day] ??= []).push(game.key);
    const rec = (me.brawlers[self.brawler.id] ??= [0, 0]);
    rec[0]++;
    if (won) rec[1]++;
    me.recent.push({
      time: game.time,
      mode: game.mode,
      mapId: game.mapId,
      map: game.map,
      brawler: self.brawler.id,
      won,
      rank: self.brawler.trophies ?? 0,
      allies: game.teams[myTeam]!.filter((id) => id !== self.brawler.id),
      enemies: game.teams[1 - myTeam]!,
    });
    added++;
  }

  me.recent.sort((a, b) => b.time - a.time);
  me.recent = me.recent.slice(0, MAX_RECENT);
  for (const day of Object.keys(me.seen)) if (day < cutoff) delete me.seen[day];
  return added;
}

export interface RosterData {
  generatedAt: string;
  tag: string;
  name: string;
  ranked: {
    rank: number | null;
    rankName: string | null;
    elo: number | null;
    seasonHighName: string | null;
    allTimeHighName: string | null;
  };
  brawlers: Array<{
    id: number;
    power: number;
    gadgets: number[];
    starPowers: number[];
    hyperCharges: number[];
    gears: number[];
    /** Your ranked games and wins with this brawler. */
    games: number;
    wins: number;
  }>;
  recent: MyGame[];
}

export function buildRoster(player: Player, me: MeState, now: Date): RosterData {
  const ids = (list?: Array<{ id: number }>) => (list ?? []).map((a) => a.id);
  return {
    generatedAt: now.toISOString(),
    tag: player.tag,
    name: player.name,
    ranked: {
      rank: player.rankedRank ?? null,
      rankName: player.rankedRankName ?? null,
      elo: player.rankedElo ?? null,
      seasonHighName: player.highestSeasonRankedRankName ?? null,
      allTimeHighName: player.highestAllTimeRankedRankName ?? null,
    },
    brawlers: player.brawlers.map((b) => {
      const [games, wins] = me.brawlers[b.id] ?? [0, 0];
      return {
        id: b.id,
        power: b.power,
        gadgets: ids(b.gadgets),
        starPowers: ids(b.starPowers),
        hyperCharges: ids(b.hyperCharges),
        gears: ids(b.gears),
        games,
        wins,
      };
    }),
    recent: me.recent.slice(0, 50),
  };
}
