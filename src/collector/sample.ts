// A random sample of each day's games, kept whole (unlike the daily totals), for checks the totals
// can't answer: whether the API lists each team in pick order, and backtests that score the engine
// against real results. Up to `cap` games per day, chosen uniformly from all of the day's new
// games across every run (reservoir sampling), so no hour of the day is over-represented.
import type { RankedGame } from "./games.js";

/** The fields of one sampled game, in order. Written into each file so it explains itself. */
export const SAMPLE_FIELDS = [
  "time", // seconds since 1970 (UTC)
  "mapId",
  "winner", // 0 or 1: which team won
  "t0a", "t0b", "t0c", // team 0's brawler ids, in the order the API lists them
  "t1a", "t1b", "t1c", // team 1's
  "owner", // where the player whose log this came from sits in that order (0-5)
  "r0a", "r0b", "r0c", "r1a", "r1b", "r1c", // each player's rank, same order
] as const;

export type SampledGame = number[];

export interface DaySample {
  date: string;
  /** Games offered to the sample so far today: the sample is a uniform pick from these. */
  seen: number;
  fields: readonly string[];
  games: SampledGame[];
}

export function emptySample(date: string): DaySample {
  return { date, seen: 0, fields: SAMPLE_FIELDS, games: [] };
}

export function toSampled(game: RankedGame): SampledGame {
  return [Math.round(game.time / 1000), game.mapId, game.winner, ...game.teams[0], ...game.teams[1], game.owner, ...game.ranks];
}

/** Offers a game to its day's sample. Keeps every game until `cap`, then each with chance cap / seen. */
export function offerGame(sample: DaySample, game: RankedGame, cap: number, random: () => number): void {
  sample.seen++;
  if (sample.games.length < cap) {
    sample.games.push(toSampled(game));
    return;
  }
  const slot = Math.floor(random() * sample.seen);
  if (slot < cap) sample.games[slot] = toSampled(game);
}

/** Reads a sampled game back by field name. */
export function fromSampled(row: SampledGame): { time: number; mapId: number; winner: 0 | 1; teams: [number[], number[]]; owner: number; ranks: number[] } {
  return {
    time: row[0]! * 1000,
    mapId: row[1]!,
    winner: row[2] as 0 | 1,
    teams: [row.slice(3, 6), row.slice(6, 9)],
    owner: row[9]!,
    ranks: row.slice(10, 16),
  };
}
