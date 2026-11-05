// Smoothed win rates for one map and mode. All rates are win probabilities (0-1).
//
// Smoothing: rate = (wins + k * prior) / (games + k). With few games the rate stays near the
// prior; with many it follows the data. Each level's prior comes from the level above it, using
// only the games *outside* this level (map games are also mode games), so no game counts twice.
//
// Carry-over: a brawler that wins elsewhere doesn't necessarily win here (a close-range brawler
// on a long-range map), so only part of its edge from other maps and modes carries over
// (`weights.carryover`). Its rate on *this* map has to come from games on this map.
//
// Matchups and pairs are measured against expectation: a strong brawler beats most enemies, so
// "A beats B 55% of the time" only means A counters B if A's own win rate predicts less than 55%.
// Each mode's games are compared with that mode's expectation, and only the *effect* (how much
// better than expected) carries over from other modes, since brawlers' strength differs by mode.
import type { Record2 } from "../collector/aggregate.js";
import type { PairStats, StatsData } from "../outputs/stats.js";
import type { Weights } from "./types.js";

const clamp = (p: number) => Math.min(0.95, Math.max(0.05, p));
const smooth = ([games, wins]: Record2, k: number, prior: number) => (wins + k * prior) / (games + k);
const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const NONE: Record2 = [0, 0];
const minus = (a: Record2, b: Record2): Record2 => [Math.max(0, a[0] - b[0]), Math.max(0, a[1] - b[1])];
/** Keep `share` of a rate's distance from 50%. */
const carry = (rate: number, share: number) => 0.5 + share * (rate - 0.5);

/** Below this many games on the map, pick rates come from the whole mode instead. */
const MIN_MAP_GAMES_FOR_PICK_RATE = 200;

export interface Edge {
  /** Advantage over expectation, as a win-probability difference (0.02 = 2 points). */
  value: number;
  /** Standard error of `value`. */
  err: number;
  games: number;
}

/** `z` standard errors closer to 0, never crossing it: an edge we're fairly sure of. */
export function cautious(edge: Edge, z: number): number {
  const shrunk = Math.abs(edge.value) - z * edge.err;
  return shrunk > 0 ? Math.sign(edge.value) * shrunk : 0;
}

export class StatsModel {
  private readonly mode: PairStats | undefined;
  private readonly mapRecords: Record<string, Record2>;
  private readonly cache = new Map<string, number>();
  private readonly k: Weights["smoothing"];
  readonly mapGames: number;

  constructor(
    private readonly stats: StatsData,
    modeKey: string,
    mapId: number,
    private readonly weights: Pick<Weights, "smoothing" | "carryover" | "gamesPerDraft">,
  ) {
    this.k = weights.smoothing;
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

  mapRecord(id: number): Record2 {
    return this.mapRecords[id] ?? NONE;
  }

  /** Win rate across all modes, smoothed toward 50%. */
  overallRate(id: number): number {
    return this.memo(`o${id}`, () => smooth(this.overallRecord(id), this.k.overall, 0.5));
  }

  /** Win rate in all other modes. */
  private otherModesRate(id: number): number {
    return this.memo(`x${id}`, () => smooth(minus(this.overallRecord(id), this.modeRecord(id)), this.k.overall, 0.5));
  }

  /** Win rate in this mode: the best estimate of how strong it is here, used for expectations. */
  modeRate(id: number): number {
    return this.memo(`m${id}`, () => smooth(this.modeRecord(id), this.k.mode, this.otherModesRate(id)));
  }

  /** Win rate on this map. With few games here it stays near 50% plus part of its edge elsewhere. */
  mapRate(id: number): number {
    return this.memo(`p${id}`, () => {
      const fromOtherModes = carry(this.otherModesRate(id), this.weights.carryover.mode);
      const otherMaps = smooth(minus(this.modeRecord(id), this.mapRecord(id)), this.k.mode, fromOtherModes);
      return smooth(this.mapRecord(id), this.k.map, carry(otherMaps, this.weights.carryover.map));
    });
  }

  /** Standard error of the map win rate: large with few games here, small with many. */
  mapRateError(id: number): number {
    return Math.sqrt((0.25 * this.weights.gamesPerDraft) / (this.mapRecord(id)[0] + this.k.map));
  }

  /** Share of games on this map (or the mode, when the map has few games) that had this brawler. */
  pickRate(id: number): number {
    if (this.mapGames >= MIN_MAP_GAMES_FOR_PICK_RATE) return this.mapRecord(id)[0] / this.mapGames;
    return this.mode?.games ? this.modeRecord(id)[0] / this.mode.games : 0;
  }

  /**
   * Standard error of a pair edge. One draft is played as 2-3 games, so games are not independent;
   * `gamesPerDraft` scales the count down to roughly independent samples.
   */
  private pairError(games: number): number {
    return Math.sqrt((0.25 * this.weights.gamesPerDraft) / (games + this.k.pairOverall));
  }

  private edge(rate: number, expected: number, games: number): Edge {
    return { value: rate - expected, err: this.pairError(games), games };
  }

  /** How much better `a` does against `b` than their win rates predict. Positive = a counters b. */
  vs(a: number, b: number): Edge {
    const sign = -1; // b is on the other team
    return this.pairEdge(orientedVs(this.stats.overall.vs, a, b), orientedVs(this.mode?.vs, a, b), a, b, sign);
  }

  /** How much better `a` and `b` do together than their win rates predict. */
  with(a: number, b: number): Edge {
    const key = pairKey(a, b);
    return this.pairEdge(this.stats.overall.with[key] ?? NONE, this.mode?.with[key] ?? NONE, a, b, 1);
  }

  /**
   * The pair's effect in other modes (against other modes' expectation) is the starting point
   * for its effect in this mode (against this mode's expectation).
   */
  private pairEdge(overall: Record2, inMode: Record2, a: number, b: number, sign: 1 | -1): Edge {
    const expectedElsewhere = clamp(0.5 + (this.otherModesRate(a) - 0.5) + sign * (this.otherModesRate(b) - 0.5));
    const expectedHere = clamp(0.5 + (this.modeRate(a) - 0.5) + sign * (this.modeRate(b) - 0.5));
    const effectElsewhere = smooth(minus(overall, inMode), this.k.pairOverall, expectedElsewhere) - expectedElsewhere;
    const rate = smooth(inMode, this.k.pairMode, clamp(expectedHere + effectElsewhere));
    return this.edge(rate, expectedHere, overall[0]);
  }

  /** Your smoothed win rate on a brawler minus its overall rate. Positive = you do better than average. */
  personalEdge(id: number, record: Record2): number {
    if (!record[0]) return 0;
    const base = this.overallRate(id);
    return smooth(record, this.k.personal, base) - base;
  }
}

/** A matchup record oriented so wins are for `a`. Stored records count wins for the lower id. */
function orientedVs(table: PairStats["vs"] | undefined, a: number, b: number): Record2 {
  const rec = table?.[pairKey(a, b)];
  if (!rec) return NONE;
  return a < b ? rec : [rec[0], rec[0] - rec[1]];
}
