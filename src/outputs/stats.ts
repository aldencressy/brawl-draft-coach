// Builds stats.json by summing the per-day aggregates over the window.
import type { DayAggregate, MapAggregate, ModeAggregate, Record2 } from "../collector/aggregate.js";

export interface PairStats {
  games: number;
  brawlers: Record<string, Record2>;
  /** "a-b" with a < b -> [games, wins for a] */
  vs: Record<string, Record2>;
  /** "a-b" with a < b -> [games, wins together] */
  with: Record<string, Record2>;
}

export interface StatsData {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  games: number;
  minRank: number;
  /** Map ids seen in the last `recentDays`, most played first: the current ranked rotation. */
  currentMaps: number[];
  maps: Record<string, MapAggregate>;
  modes: Record<string, PairStats>;
  /** All modes combined, for matchups with too few games in one mode. */
  overall: PairStats;
}

function addRecords(into: Record<string, Record2>, from: Record<string, Record2>): void {
  for (const [key, [g, w]] of Object.entries(from)) {
    const rec = (into[key] ??= [0, 0]);
    rec[0] += g;
    rec[1] += w;
  }
}

const emptyPairs = (): PairStats => ({ games: 0, brawlers: {}, vs: {}, with: {} });

function addMode(into: PairStats, from: ModeAggregate): void {
  into.games += from.games;
  addRecords(into.brawlers, from.brawlers);
  addRecords(into.vs, from.vs);
  addRecords(into.with, from.with);
}

export function buildStats(days: DayAggregate[], minRank: number, now: Date, recentDays = 2): StatsData {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const maps: Record<string, MapAggregate> = {};
  const modes: Record<string, PairStats> = {};
  const overall = emptyPairs();

  for (const day of sorted) {
    for (const [id, m] of Object.entries(day.maps)) {
      const map = (maps[id] ??= { name: m.name, mode: m.mode, games: 0, brawlers: {} });
      map.games += m.games;
      addRecords(map.brawlers, m.brawlers);
    }
    for (const [key, m] of Object.entries(day.modes)) {
      addMode((modes[key] ??= emptyPairs()), m);
      addMode(overall, m);
    }
  }

  const recentCutoff = new Date(now.getTime() - (recentDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const recentGames = new Map<string, number>();
  for (const day of sorted.filter((d) => d.date >= recentCutoff)) {
    for (const [id, m] of Object.entries(day.maps)) recentGames.set(id, (recentGames.get(id) ?? 0) + m.games);
  }

  return {
    generatedAt: now.toISOString(),
    window: { from: sorted[0]?.date ?? "", to: sorted.at(-1)?.date ?? "", days: sorted.length },
    games: sorted.reduce((n, d) => n + d.games, 0),
    minRank,
    currentMaps: [...recentGames.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => Number(id)),
    maps,
    modes,
    overall,
  };
}
