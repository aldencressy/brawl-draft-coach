// Backtest: how well the engine's view of a finished 3v3 predicts who actually won, on games it
// hasn't seen. Stats come from the days before the test day; the test games are the collector's
// sample of that day (games/<date>.json). The engine never sees a test game while learning.
//
// For each game, each team's total is what the engine scores: map strength (luck removed), its
// matchups against the other team, and its teammate pairs (× synergyWeight). The win chance is
// 0.5 plus the difference. Comparing log loss across variants says which weighting predicts best,
// and a logistic fit gives the best weight for each part (1 = as the engine weighs it now).
import { fromSampled, type SampledGame } from "../collector/sample.js";
import type { StatsData } from "../outputs/stats.js";
import { StatsModel } from "./model.js";
import type { Weights } from "./types.js";

/** One game's parts, team 0 minus team 1, in win-rate fractions; `y` is 1 if team 0 won. */
export interface GameParts {
  map: number;
  counter: number;
  synergy: number;
  /** Map strength with matchup luck left in (the raw map win rate), for comparison. */
  rawMap: number;
  y: 0 | 1;
}

export function gameParts(stats: StatsData, modeOf: (mapId: number) => string, rows: SampledGame[], weights: Weights): GameParts[] {
  const models = new Map<number, StatsModel>();
  const modelFor = (mapId: number) => {
    let m = models.get(mapId);
    if (!m) models.set(mapId, (m = new StatsModel(stats, modeOf(mapId), mapId, weights)));
    return m;
  };
  return rows.map((row) => {
    const g = fromSampled(row);
    const m = modelFor(g.mapId);
    const [a, b] = g.teams;
    const sum = (team: number[], f: (id: number) => number) => team.reduce((t, id) => t + f(id), 0);
    let counter = 0;
    // vs(x, y) and vs(y, x) are near mirror images; averaging them keeps the sum exactly antisymmetric.
    for (const x of a) for (const y of b) counter += (m.vs(x, y).value - m.vs(y, x).value) / 2;
    const pairs = (t: number[]) => m.with(t[0]!, t[1]!).value + m.with(t[0]!, t[2]!).value + m.with(t[1]!, t[2]!).value;
    return {
      map: sum(a, (id) => m.strength(id) - 0.5) - sum(b, (id) => m.strength(id) - 0.5),
      rawMap: sum(a, (id) => m.mapRate(id) - 0.5) - sum(b, (id) => m.mapRate(id) - 0.5),
      counter,
      synergy: weights.synergyWeight * (pairs(a) - pairs(b)),
      y: g.winner === 0 ? 1 : 0,
    };
  });
}

/** The engine's win chance for team 0, with optional multipliers on each part. */
export function predict(g: GameParts, k: { map?: number; counter?: number; synergy?: number; rawMap?: boolean } = {}): number {
  const map = k.rawMap ? g.rawMap : g.map;
  return 0.5 + (k.map ?? 1) * map + (k.counter ?? 1) * g.counter + (k.synergy ?? 1) * g.synergy;
}

const clamp = (p: number) => Math.min(0.97, Math.max(0.03, p));
const logLoss = (p: number, y: number) => -(y * Math.log(p) + (1 - y) * Math.log(1 - p));

export interface Score {
  /** Mean log loss (lower is better; a coin flip is 0.693). */
  loss: number;
  /** Share of games where the favored team won. */
  accuracy: number;
}

/** Log loss and accuracy of `pred`; with `ref`, also the mean difference in loss and its standard error. */
export function score(games: GameParts[], pred: (g: GameParts) => number, ref?: (g: GameParts) => number): Score & { diff: number; se: number } {
  let sum = 0, right = 0, dSum = 0, dSq = 0;
  for (const g of games) {
    const p = clamp(pred(g));
    const l = logLoss(p, g.y);
    sum += l;
    if ((p > 0.5 ? 1 : 0) === g.y) right++;
    if (ref) {
      const d = l - logLoss(clamp(ref(g)), g.y);
      dSum += d;
      dSq += d * d;
    }
  }
  const n = games.length || 1;
  const diff = dSum / n;
  return { loss: sum / n, accuracy: right / n, diff, se: Math.sqrt(Math.max(0, dSq / n - diff * diff) / n) };
}

/**
 * The best weight for each part, fitted by logistic regression (with an intercept), in engine
 * units: 1 means the engine already weighs that part right. Near 50%, a change of x in win chance
 * is 4x in log-odds, hence the / 4.
 */
export function fitWeights(games: GameParts[], keys: Array<"map" | "counter" | "synergy">): Array<{ key: string; weight: number; se: number }> {
  const k = keys.length + 1;
  const x = (g: GameParts) => [1, ...keys.map((key) => g[key])];
  let beta = new Array<number>(k).fill(0);
  const hessian = () => {
    const H = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const grad = new Array<number>(k).fill(0);
    for (const g of games) {
      const xi = x(g);
      const p = 1 / (1 + Math.exp(-xi.reduce((t, v, i) => t + v * beta[i]!, 0)));
      for (let i = 0; i < k; i++) {
        grad[i]! += (g.y - p) * xi[i]!;
        for (let j = 0; j < k; j++) H[i]![j]! += p * (1 - p) * xi[i]! * xi[j]!;
      }
    }
    return { H, grad };
  };
  for (let it = 0; it < 30; it++) {
    const { H, grad } = hessian();
    const step = solve(H, grad);
    beta = beta.map((b, i) => b + step[i]!);
    if (Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  const { H } = hessian();
  return keys.map((key, i) => {
    const unit = new Array<number>(k).fill(0);
    unit[i + 1] = 1;
    const variance = solve(H, unit)[i + 1]!;
    return { key, weight: beta[i + 1]! / 4, se: Math.sqrt(Math.max(0, variance)) / 4 };
  });
}

/** Solves A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r]![i]!) > Math.abs(M[pivot]![i]!)) pivot = r;
    [M[i], M[pivot]] = [M[pivot]!, M[i]!];
    for (let r = 0; r < n; r++) {
      if (r === i || M[i]![i] === 0) continue;
      const f = M[r]![i]! / M[i]![i]!;
      for (let c = i; c <= n; c++) M[r]![c]! -= f * M[i]![c]!;
    }
  }
  return M.map((row, i) => (row[i] ? row[n]! / row[i]! : 0));
}
