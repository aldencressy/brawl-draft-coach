// Smoothed win rates for one map and mode. All rates are win probabilities (0-1).
//
// Smoothing: rate = (wins + k * prior) / (games + k). With few games the rate stays near the
// prior; with many it follows the data. Each level's prior comes from the level above it, using
// only the games *outside* this level (map games are also mode games), so no game counts twice.
//
// Matchups and pairs are measured against expectation: a strong brawler beats most enemies, so
// "A beats B 55% of the time" only means A counters B if A's own win rate predicts less than 55%.
import type { Record2 } from "../collector/aggregate.js";
import type { PairStats, StatsData } from "../outputs/stats.js";
import type { Weights } from "./types.js";

const clamp = (p: number) => Math.min(0.95, Math.max(0.05, p));
const smooth = ([games, wins]: Record2, k: number, prior: number) => (wins + k * prior) / (games + k);
const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const NONE: Record2 = [0, 0];
const minus = (a: Record2, b: Record2): Record2 => [Math.max(0, a[0] - b[0]), Math.max(0, a[1] - b[1])];

/** A matchup record oriented so wins are for `a`. Stored records count wins for the lower id. */
function orientedVs(table: PairStats["vs"] | undefined, a: number, b: number): Record2 {
  const rec = table?.[pairKey(a, b)];
  if (!rec) return NONE;
  return a < b ? rec : [rec[0], rec[0] - rec[1]];
}

export interface Edge {
  /** Advantage over expectation, as a win-probability difference (0.02 = 2 points). */
  value: number;
  games: number;
}

export class StatsModel {
  private readonly mode: PairStats | undefined;
  private readonly mapRecords: Record<string, Record2>;
  private readonly cache = new Map<string, number>();
  readonly mapGames: number;

  constructor(
    private readonly stats: StatsData,
    modeKey: string,
    mapId: number,
    private readonly k: Weights["smoothing"],
  ) {
    this.mode = stats.modes[modeKey];
    const map = stats.maps[mapId];
    this.mapRecords = map?.brawlers ?? {};
    this.mapGames = map?.games ?? 0;
  }

  private memo(key: string, compute: () => number): number {
    let v = this.cache.get(key);
    if (v === undefined) this.cache.set(key, (v = compute()));
    return v;
  }

  private overallRecord(id: number): Record2 {
    return this.stats.overall.brawlers[id] ?? NONE;
  }

  private modeRecord(id: number): Record2 {
    return this.mode?.brawlers[id] ?? NONE;
  }

  /** Win rate across all modes, smoothed toward 50%. */
  overallRate(id: number): number {
    return this.memo(`o${id}`, () => smooth(this.overallRecord(id), this.k.overall, 0.5));
  }

  /** Win rate in this mode, smoothed toward the brawler's rate in other modes. */
  modeRate(id: number): number {
    return this.memo(`m${id}`, () => {
      const otherModes = smooth(minus(this.overallRecord(id), this.modeRecord(id)), this.k.overall, 0.5);
      return smooth(this.modeRecord(id), this.k.mode, otherModes);
    });
  }

  /** Win rate on this map, smoothed toward the brawler's rate on the mode's other maps (the fallback when map data is thin). */
  mapRate(id: number): number {
    return this.memo(`p${id}`, () => {
      const otherModes = smooth(minus(this.overallRecord(id), this.modeRecord(id)), this.k.overall, 0.5);
      const otherMaps = smooth(minus(this.modeRecord(id), this.mapRecord(id)), this.k.mode, otherModes);
      return smooth(this.mapRecord(id), this.k.map, otherMaps);
    });
  }

  mapRecord(id: number): Record2 {
    return this.mapRecords[id] ?? NONE;
  }

  /** How much better `a` does against `b` than their mode win rates predict. Positive = a counters b. */
  vs(a: number, b: number): Edge {
    const expected = clamp(0.5 + (this.modeRate(a) - 0.5) - (this.modeRate(b) - 0.5));
    const overall = orientedVs(this.stats.overall.vs, a, b);
    const inMode = orientedVs(this.mode?.vs, a, b);
    const otherModes = smooth(minus(overall, inMode), this.k.pairOverall, expected);
    const rate = smooth(inMode, this.k.pairMode, otherModes);
    return { value: rate - expected, games: overall[0] };
  }

  /** How much better `a` and `b` do together than their mode win rates predict. */
  with(a: number, b: number): Edge {
    const expected = clamp(0.5 + (this.modeRate(a) - 0.5) + (this.modeRate(b) - 0.5));
    const overall = this.stats.overall.with[pairKey(a, b)] ?? NONE;
    const inMode = this.mode?.with[pairKey(a, b)] ?? NONE;
    const otherModes = smooth(minus(overall, inMode), this.k.pairOverall, expected);
    const rate = smooth(inMode, this.k.pairMode, otherModes);
    return { value: rate - expected, games: overall[0] };
  }

  /** Your smoothed win rate on a brawler minus its overall rate. Positive = you do better than average. */
  personalEdge(id: number, record: Record2): number {
    if (!record[0]) return 0;
    const base = this.overallRate(id);
    return smooth(record, this.k.personal, base) - base;
  }
}
