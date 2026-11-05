import type { RankedGame } from "./games.js";

/** [games, wins] */
export type Record2 = [number, number];

export interface MapAggregate {
  name: string;
  mode: string;
  games: number;
  /** brawlerId -> [games, wins] */
  brawlers: Record<string, Record2>;
}

export interface ModeAggregate {
  games: number;
  brawlers: Record<string, Record2>;
  /** "a-b" with a < b -> [games, wins for a]. Wins for b = games - wins for a. */
  vs: Record<string, Record2>;
  /** "a-b" with a < b -> [games, wins] when on the same team. */
  with: Record<string, Record2>;
}

/** Everything we keep for one UTC day. Raw games are not stored. */
export interface DayAggregate {
  date: string;
  games: number;
  maps: Record<string, MapAggregate>;
  modes: Record<string, ModeAggregate>;
}

export function emptyDay(date: string): DayAggregate {
  return { date, games: 0, maps: {}, modes: {} };
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function bump(table: Record<string, Record2>, key: string | number, won: boolean): void {
  const rec = (table[key] ??= [0, 0]);
  rec[0]++;
  if (won) rec[1]++;
}

export function addGame(day: DayAggregate, game: RankedGame): void {
  day.games++;
  const map = (day.maps[game.mapId] ??= { name: game.map, mode: game.mode, games: 0, brawlers: {} });
  const mode = (day.modes[game.mode] ??= { games: 0, brawlers: {}, vs: {}, with: {} });
  map.games++;
  mode.games++;

  game.teams.forEach((team, t) => {
    const won = game.winner === t;
    const enemies = game.teams[1 - t]!;
    for (const id of team) {
      bump(map.brawlers, id, won);
      bump(mode.brawlers, id, won);
    }
    // Each teammate pair once per team.
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) bump(mode.with, pairKey(team[i]!, team[j]!), won);
    }
    // Each cross-team pair once overall: count it from the side of the lower id.
    for (const a of team) {
      for (const b of enemies) if (a < b) bump(mode.vs, pairKey(a, b), won);
    }
  });
}

/** Keeps only the newest `windowDays` days, counting back from `today`. */
export function pruneDays(dates: string[], today: string, windowDays: number): { keep: string[]; drop: string[] } {
  const cutoff = new Date(Date.parse(today) - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
  return { keep: dates.filter((d) => d >= cutoff), drop: dates.filter((d) => d < cutoff) };
}
