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
//
// Pair effects use empirical Bayes: from all pairs in the data we fit how much real effects vary
// and how noisy one game is, then shrink each pair's observed effect toward 0 by exactly as much
// as its sample size calls for. Real counters with enough games keep most of their size; a
// handful of lucky games shrinks to almost nothing.
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
/** Pairs with at least this many games help estimate pair effects' spread and noise. */
const MIN_GAMES_FOR_SPREAD = 30;
/** Floors, so effects are never shrunk to exactly 0 and noise is never below a fair coin's. */
const MIN_SPREAD = 0.005;
const MIN_NOISE_PER_GAME = 0.25;
/** Noise per game when the data can't separate noise from spread (measured ~0.27-0.30 on real data). */
const DEFAULT_NOISE_PER_GAME = 0.3;

/** How much real pair effects vary (`spread`, a variance) and the noise of one game (`perGame`). */
interface PairFit {
  spread: number;
  perGame: number;
}

const fitCache = new WeakMap<StatsData, { vs: PairFit; with: PairFit }>();
const luckCache = new WeakMap<StatsData, Map<string, Map<number, Luck>>>();

/** Average pair effects a brawler had in its real games: per enemy faced and per teammate had. */
export interface Luck {
  perEnemy: number;
  perTeammate: number;
}

/**
 * Fitted once per stats file. Across all pairs, the observed effect's variance is
 * spread + perGame / games: pairs with few games vary mostly from noise, pairs with many games
 * mostly from real effects. A weighted line through games-binned pairs gives both numbers.
 */
function fitPairs(stats: StatsData, overallK: number): { vs: PairFit; with: PairFit } {
  const cached = fitCache.get(stats);
  if (cached) return cached;
  const rate = (id: number) => smooth(stats.overall.brawlers[id] ?? NONE, overallK, 0.5);
  const fit = (table: Record<string, Record2>, sign: 1 | -1): PairFit => {
    const bins = [30, 60, 120, 250, 500, 1000, 2000].map((lo) => ({ lo, n: 0, sq: 0, inv: 0 }));
    for (const [key, [games, wins]] of Object.entries(table)) {
      if (games < MIN_GAMES_FOR_SPREAD) continue;
      const bin = [...bins].reverse().find((b) => games >= b.lo)!;
      const [a, b] = key.split("-").map(Number) as [number, number]; // wins are for a, the lower id
      const expected = clamp(0.5 + (rate(a) - 0.5) + sign * (rate(b) - 0.5));
      bin.sq += (wins / games - expected) ** 2;
      bin.inv += 1 / games;
      bin.n++;
    }
    let w = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const b of bins.filter((b) => b.n >= Math.min(20, 1 + Object.keys(table).length / 10))) {
      const x = b.inv / b.n;
      const y = b.sq / b.n;
      w += b.n;
      sx += b.n * x;
      sy += b.n * y;
      sxx += b.n * x * x;
      sxy += b.n * x * y;
    }
    if (w === 0) return { spread: MIN_SPREAD ** 2, perGame: DEFAULT_NOISE_PER_GAME };
    // With pairs of only one size, the line can't be fitted: assume the usual noise, fit the spread.
    const denominator = w * sxx - sx * sx;
    const fitted = denominator > 1e-12 * w * w ? (w * sxy - sx * sy) / denominator : DEFAULT_NOISE_PER_GAME;
    const perGame = Math.max(MIN_NOISE_PER_GAME, fitted);
    const spread = Math.max(MIN_SPREAD ** 2, (sy - perGame * sx) / w);
    return { spread, perGame };
  };
  const result = { vs: fit(stats.overall.vs, -1), with: fit(stats.overall.with, 1) };
  fitCache.set(stats, result);
  return result;
}

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
  private readonly mapExposure: Record<string, number>;
  private readonly modeExposure: Record<string, number>;
  private readonly cache = new Map<string, number>();
  private readonly pairCache = new Map<string, Edge>();
  private readonly k: Weights["smoothing"];
  readonly mapGames: number;

  constructor(
    private readonly stats: StatsData,
    private readonly modeKey: string,
    mapId: number,
    private readonly weights: Pick<Weights, "smoothing" | "carryover" | "gamesPerDraft">,
  ) {
    this.k = weights.smoothing;
    this.mode = stats.modes[modeKey];
    const map = stats.maps[mapId];
    this.mapRecords = map?.brawlers ?? {};
    this.mapGames = map?.games ?? 0;
    this.mapExposure = stats.exposure?.maps[mapId] ?? {};
    this.modeExposure = stats.exposure?.modes[modeKey] ?? {};
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

  /**
   * The matchups and teammates a brawler actually got, on average, in its games in this mode: its
   * pair effect per enemy faced and per teammate had. Brawlers picked when it's safe (late, into
   * no counters) have positive matchup luck that inflates their win rate; popular blind picks
   * that get countered a lot have negative luck.
   */
  luck(id: number): Luck {
    let byMode = luckCache.get(this.stats);
    if (!byMode) luckCache.set(this.stats, (byMode = new Map()));
    let luck = byMode.get(this.modeKey);
    if (!luck) {
      const vs = new Map<number, number>();
      const team = new Map<number, number>();
      const add = (sums: Map<number, number>, b: number, amount: number) => sums.set(b, (sums.get(b) ?? 0) + amount);
      for (const [key, [games]] of Object.entries(this.mode?.vs ?? {})) {
        const [a, b] = key.split("-").map(Number) as [number, number];
        add(vs, a, games * this.vs(a, b).value);
        add(vs, b, games * this.vs(b, a).value);
      }
      for (const [key, [games]] of Object.entries(this.mode?.with ?? {})) {
        const [a, b] = key.split("-").map(Number) as [number, number];
        const v = this.with(a, b).value;
        add(team, a, games * v);
        add(team, b, games * v);
      }
      // A brawler faces 3 enemies and has 2 teammates per game.
      const ids = new Set([...vs.keys(), ...team.keys()]);
      luck = new Map(
        [...ids].map((b) => {
          const games = Math.max(1, this.modeRecord(b)[0]);
          return [b, { perEnemy: (vs.get(b) ?? 0) / (3 * games), perTeammate: (team.get(b) ?? 0) / (2 * games) }];
        }),
      );
      byMode.set(this.modeKey, luck);
    }
    return luck.get(id) ?? { perEnemy: 0, perTeammate: 0 };
  }

  /**
   * Strength on this map with that luck removed: what the brawler is worth before matchups and
   * teammates, which are counted separately (for the picks known now and the ones predicted).
   */
  strength(id: number): number {
    return this.memo(`s${id}`, () => {
      const { perEnemy, perTeammate } = this.luck(id);
      return this.mapRate(id) - 3 * perEnemy - 2 * perTeammate;
    });
  }

  /** Standard error of the map win rate: large with few games here, small with many. */
  mapRateError(id: number): number {
    return Math.sqrt((0.25 * this.weights.gamesPerDraft) / (this.mapRecord(id)[0] + this.k.map));
  }

  /**
   * Share of games on this map that had this brawler. For a brawler whose older games are discounted
   * after a change, it's a share of the games it could have been in (see StatsData.exposure).
   */
  mapShare(id: number): number {
    const games = this.mapExposure[id] ?? this.mapGames;
    return games ? this.mapRecord(id)[0] / games : 0;
  }

  /** Share of games on this map (or the mode, when the map has few games) that had this brawler. */
  pickRate(id: number): number {
    if (this.mapGames >= MIN_MAP_GAMES_FOR_PICK_RATE) return this.mapShare(id);
    const games = this.modeExposure[id] ?? this.mode?.games ?? 0;
    return games ? this.modeRecord(id)[0] / games : 0;
  }

  /** How much better `a` does against `b` than their win rates predict. Positive = a counters b. */
  vs(a: number, b: number): Edge {
    const key = `v${a},${b}`;
    let edge = this.pairCache.get(key);
    if (!edge) {
      const sign = -1; // b is on the other team
      edge = this.pairEdge(orientedVs(this.stats.overall.vs, a, b), orientedVs(this.mode?.vs, a, b), a, b, sign, "vs");
      this.pairCache.set(key, edge);
    }
    return edge;
  }

  /** How much better `a` and `b` do together than their win rates predict. */
  with(a: number, b: number): Edge {
    const key = pairKey(a, b);
    let edge = this.pairCache.get(key);
    if (!edge) {
      edge = this.pairEdge(this.stats.overall.with[key] ?? NONE, this.mode?.with[key] ?? NONE, a, b, 1, "with");
      this.pairCache.set(key, edge);
    }
    return edge;
  }

  /**
   * Combines the pair's observed effect in this mode and in other modes (each against its own
   * expectation; other modes' games count `carryover.mode` as much) with the prior that real
   * effects are spread around 0 with the variance estimated from all pairs.
   */
  private pairEdge(overall: Record2, inMode: Record2, a: number, b: number, sign: 1 | -1, kind: "vs" | "with"): Edge {
    const expectedElsewhere = clamp(0.5 + (this.otherModesRate(a) - 0.5) + sign * (this.otherModesRate(b) - 0.5));
    const expectedHere = clamp(0.5 + (this.modeRate(a) - 0.5) + sign * (this.modeRate(b) - 0.5));
    const elsewhere = minus(overall, inMode);
    const { spread, perGame } = fitPairs(this.stats, this.k.overall)[kind];
    // The evidence: a precision-weighted average of the effect here and elsewhere.
    const evidenceElsewhere = (this.weights.carryover.mode * elsewhere[0]) / perGame;
    const evidenceHere = inMode[0] / perGame;
    const evidence = evidenceElsewhere + evidenceHere;
    if (evidence === 0) return { value: 0, err: Math.sqrt(spread), games: overall[0] };
    const effectElsewhere = elsewhere[0] ? elsewhere[1] / elsewhere[0] - expectedElsewhere : 0;
    const effectHere = inMode[0] ? inMode[1] / inMode[0] - expectedHere : 0;
    const observed = (evidenceElsewhere * effectElsewhere + evidenceHere * effectHere) / evidence;
    // Bell-curve prior around 0 with the fitted spread (real data's pair effects are bell-shaped:
    // kurtosis ~3.0): shrink by spread / (spread + noise).
    const precision = 1 / spread + evidence;
    return { value: (evidence * observed) / precision, err: Math.sqrt(1 / precision), games: overall[0] };
  }

  /** The fitted pair model, for reports: real-effect spread (standard deviation) and noise per game. */
  pairFit(): { vs: { spread: number; perGame: number }; with: { spread: number; perGame: number } } {
    const f = fitPairs(this.stats, this.k.overall);
    return {
      vs: { spread: Math.sqrt(f.vs.spread), perGame: f.vs.perGame },
      with: { spread: Math.sqrt(f.with.spread), perGame: f.with.perGame },
    };
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
