// Builds stats.json by summing the per-day aggregates over the window.
//
// Days are weighted so the stats follow balance changes: each day counts `recencyDecay` times as
// much as the day after it, and days before a known balance change can be dropped or discounted.
// A change to one brawler (a buff, a nerf, new Buffies) discounts only that brawler's older games:
// its own records and its matchups and pairs. Everyone else's games still count in full.
// Counts in stats.json are therefore *weighted* games (rounded). The raw daily totals on the data
// branch are untouched, so changing these settings is always reversible.
import type { DayAggregate, MapAggregate, ModeAggregate, Record2 } from "../collector/aggregate.js";
import { nameKey } from "./static.js";

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
  /** Changes to single brawlers: that brawler's games before `date` are multiplied by `weightBefore`. */
  brawlerChanges?: BrawlerChange[];
}

export interface BrawlerChange {
  id: number;
  name?: string;
  /** "YYYY-MM-DD", the day the change went live. That day counts in full. */
  date: string;
  weightBefore: number;
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
  /**
   * For brawlers with a change in `weighting.brawlerChanges`: the weighted games they could have
   * appeared in (per map id and per mode), with their own discount applied. Their pick rate is their
   * games divided by this, not by all games, or discounting their old games would make them look
   * rarely picked.
   */
  exposure?: { maps: Record<string, Record<string, number>>; modes: Record<string, Record<string, number>> };
}

/** How much a record counts on top of the day's weight: 1 unless it involves a changed brawler. */
type KeyWeight = (key: string) => number;

function addRecords(into: Record<string, Record2>, from: Record<string, Record2>, weight: number, keyWeight?: KeyWeight): void {
  for (const [key, [g, w]] of Object.entries(from)) {
    const k = weight * (keyWeight ? keyWeight(key) : 1);
    if (k === 0) continue;
    const rec = (into[key] ??= [0, 0]);
    rec[0] += g * k;
    rec[1] += w * k;
  }
}

const emptyPairs = (): PairStats => ({ games: 0, brawlers: {}, vs: {}, with: {} });

function addMode(into: PairStats, from: ModeAggregate, weight: number, byBrawler: KeyWeight, byPair: KeyWeight): void {
  into.games += from.games * weight;
  addRecords(into.brawlers, from.brawlers, weight, byBrawler);
  addRecords(into.vs, from.vs, weight, byPair);
  addRecords(into.with, from.with, weight, byPair);
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

/** Per-brawler discounts for one day: brawler id -> factor, for changed brawlers whose change is after it. */
function changedOn(date: string, w: Weighting): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of w.brawlerChanges ?? []) if (date < c.date) out.set(c.id, (out.get(c.id) ?? 1) * c.weightBefore);
  return out;
}

/**
 * Turns `brawlerChanges` from config (by name) into ids. Unknown names are reported through `warn`
 * and skipped, so a typo can't silently do nothing.
 */
export function resolveBrawlerChanges(
  changes: Array<{ brawler: string; date: string; weightBefore?: number }> | undefined,
  brawlers: Array<{ id: number; name: string }>,
  warn: (msg: string) => void,
): BrawlerChange[] {
  return (changes ?? []).flatMap((c) => {
    const b = brawlers.find((x) => nameKey(x.name) === nameKey(c.brawler));
    if (!b) {
      warn(`brawlerChanges: no brawler named "${c.brawler}"`);
      return [];
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date)) {
      warn(`brawlerChanges: "${c.brawler}" needs a date like 2026-11-05, not "${c.date}"`);
      return [];
    }
    return [{ id: b.id, name: b.name, date: c.date, weightBefore: c.weightBefore ?? 0 }];
  });
}

export function buildStats(days: DayAggregate[], minRank: number, now: Date, weighting: Weighting = NO_WEIGHTING, recentDays = 2): StatsData {
  const today = now.toISOString().slice(0, 10);
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const used = sorted.filter((d) => dayWeight(d.date, today, weighting) > 0);
  const maps: Record<string, MapAggregate> = {};
  const modes: Record<string, PairStats> = {};
  const overall = emptyPairs();
  let effectiveGames = 0;

  const changed = weighting.brawlerChanges ?? [];
  const exposure = { maps: {} as Record<string, Record<string, number>>, modes: {} as Record<string, Record<string, number>> };
  const expose = (table: Record<string, Record<string, number>>, where: string, games: number, factors: Map<number, number>) => {
    for (const c of changed) {
      const row = (table[where] ??= {});
      row[c.id] = (row[c.id] ?? 0) + games * (factors.get(c.id) ?? 1);
    }
  };

  for (const day of used) {
    const weight = dayWeight(day.date, today, weighting);
    effectiveGames += day.games * weight;
    const factors = changedOn(day.date, weighting);
    const byBrawler: KeyWeight = (key) => factors.get(Number(key)) ?? 1;
    const byPair: KeyWeight = (key) => {
      if (!factors.size) return 1;
      const [a, b] = key.split("-").map(Number) as [number, number];
      return (factors.get(a) ?? 1) * (factors.get(b) ?? 1);
    };
    for (const [id, m] of Object.entries(day.maps)) {
      const map = (maps[id] ??= { name: m.name, mode: m.mode, games: 0, brawlers: {} });
      map.games += m.games * weight;
      addRecords(map.brawlers, m.brawlers, weight, byBrawler);
      expose(exposure.maps, id, m.games * weight, factors);
    }
    for (const [key, m] of Object.entries(day.modes)) {
      addMode((modes[key] ??= emptyPairs()), m, weight, byBrawler, byPair);
      addMode(overall, m, weight, byBrawler, byPair);
      expose(exposure.modes, key, m.games * weight, factors);
    }
  }
  for (const table of [exposure.maps, exposure.modes]) {
    for (const row of Object.values(table)) for (const id of Object.keys(row)) row[id] = Math.round(row[id]!);
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
    ...(changed.length ? { exposure } : {}),
  };
}
