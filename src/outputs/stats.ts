// Builds stats.json by summing the per-day aggregates over the window.
//
// Days are weighted so the stats follow balance changes: each day counts `recencyDecay` times as
// much as the day after it, and days before a known balance change can be dropped or discounted.
// Counts in stats.json are therefore *weighted* games (rounded). The raw daily totals on the data
// branch are untouched, so changing these settings is always reversible.
import type { DayAggregate, MapAggregate, ModeAggregate, Record2 } from "../collector/aggregate.js";

export interface PairStats {
  games: number;
  brawlers: Record<string, Record2>;
  /** "a-b" with a < b -> [games, wins for a] */
  vs: Record<string, Record2>;
  /** "a-b" with a < b -> [games, wins together] */
  with: Record<string, Record2>;
}

export interface Weighting {
  /** Each day counts this much relative to the next one (1 = all days equal). */
  recencyDecay: number;
  /** A balance change: days before `date` are multiplied by `weightBefore` (0 = dropped). */
  balanceChange: { date: string | null; weightBefore: number };
}

export const NO_WEIGHTING: Weighting = { recencyDecay: 1, balanceChange: { date: null, weightBefore: 1 } };

export interface StatsData {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  /** Raw games in the window. */
  games: number;
  /** Games after weighting: what the counts below add up to. */
  effectiveGames: number;
  weighting: Weighting;
  minRank: number;
  /** Map ids seen in the last `recentDays`, most played first: the current ranked rotation. */
  currentMaps: number[];
  maps: Record<string, MapAggregate>;
  modes: Record<string, PairStats>;
  /** All modes combined, for matchups with too few games in one mode. */
  overall: PairStats;
}

function addRecords(into: Record<string, Record2>, from: Record<string, Record2>, weight: number): void {
  for (const [key, [g, w]] of Object.entries(from)) {
    const rec = (into[key] ??= [0, 0]);
    rec[0] += g * weight;
    rec[1] += w * weight;
  }
}

const emptyPairs = (): PairStats => ({ games: 0, brawlers: {}, vs: {}, with: {} });

function addMode(into: PairStats, from: ModeAggregate, weight: number): void {
  into.games += from.games * weight;
  addRecords(into.brawlers, from.brawlers, weight);
  addRecords(into.vs, from.vs, weight);
  addRecords(into.with, from.with, weight);
}

/** Weighted sums back to whole games, so stats.json stays compact. */
function roundRecords(table: Record<string, Record2>): void {
  for (const [key, [g, w]] of Object.entries(table)) {
    const games = Math.round(g);
    if (games === 0) delete table[key];
    else table[key] = [games, Math.min(games, Math.round(w))];
  }
}

function roundPairs(p: PairStats): void {
  p.games = Math.round(p.games);
  roundRecords(p.brawlers);
  roundRecords(p.vs);
  roundRecords(p.with);
}

/** How much a day counts: newer days more, days before a balance change less (or not at all). */
export function dayWeight(date: string, today: string, w: Weighting): number {
  const age = Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000));
  const beforeChange = w.balanceChange.date !== null && date < w.balanceChange.date;
  return w.recencyDecay ** age * (beforeChange ? w.balanceChange.weightBefore : 1);
}

export function buildStats(days: DayAggregate[], minRank: number, now: Date, weighting: Weighting = NO_WEIGHTING, recentDays = 2): StatsData {
  const today = now.toISOString().slice(0, 10);
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const used = sorted.filter((d) => dayWeight(d.date, today, weighting) > 0);
  const maps: Record<string, MapAggregate> = {};
  const modes: Record<string, PairStats> = {};
  const overall = emptyPairs();
  let effectiveGames = 0;

  for (const day of used) {
    const weight = dayWeight(day.date, today, weighting);
    effectiveGames += day.games * weight;
    for (const [id, m] of Object.entries(day.maps)) {
      const map = (maps[id] ??= { name: m.name, mode: m.mode, games: 0, brawlers: {} });
      map.games += m.games * weight;
      addRecords(map.brawlers, m.brawlers, weight);
    }
    for (const [key, m] of Object.entries(day.modes)) {
      addMode((modes[key] ??= emptyPairs()), m, weight);
      addMode(overall, m, weight);
    }
  }
  for (const map of Object.values(maps)) {
    map.games = Math.round(map.games);
    roundRecords(map.brawlers);
  }
  Object.values(modes).forEach(roundPairs);
  roundPairs(overall);

  const recentCutoff = new Date(now.getTime() - (recentDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const recentGames = new Map<string, number>();
  for (const day of sorted.filter((d) => d.date >= recentCutoff)) {
    for (const [id, m] of Object.entries(day.maps)) recentGames.set(id, (recentGames.get(id) ?? 0) + m.games);
  }

  return {
    generatedAt: now.toISOString(),
    window: { from: used[0]?.date ?? "", to: used.at(-1)?.date ?? "", days: used.length },
    games: used.reduce((n, d) => n + d.games, 0),
    effectiveGames: Math.round(effectiveGames),
    weighting,
    minRank,
    currentMaps: [...recentGames.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => Number(id)),
    maps,
    modes,
    overall,
  };
}
