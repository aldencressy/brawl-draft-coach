import { readFileSync } from "node:fs";

export interface CollectorConfig {
  /** battle.type for ranked draft. Confirmed against real logs ("ranked" is the trophy ladder). */
  rankedBattleType: string;
  /** Keep matches whose players' average rank is at least this. 13 = Mythic I, 16 = Legendary I, 19 = Masters I. */
  minRank: number;
  seedCountries: string[];
  seedEveryHours: number;
  poolCap: number;
  maxLogsPerRun: number;
  maxRunMinutes: number;
  /** Battle logs fetched in parallel; the client's rate limit still applies across all of them. */
  concurrency: number;
  windowDays: number;
  /** How long to remember match keys for dedupe. Must exceed how long a game can stay in someone's log. */
  seenKeyDays: number;
  /**
   * Games per day kept whole in games/<date>.json, a uniform random sample of the day (0 or missing =
   * none). Used to check whether the API lists teams in pick order and to backtest the engine.
   */
  sampleGamesPerDay?: number;
  /** stats.json weighting: each day counts this much relative to the next one (1 = all equal). */
  recencyDecay: number;
  /**
   * After a balance patch or buffy release, set `date` ("YYYY-MM-DD", the day it went live).
   * Days before it are multiplied by `weightBefore`: 0 drops them, 0.3 keeps 30%. `null` = none.
   */
  balanceChange: { date: string | null; weightBefore: number };
  /**
   * Changes to single brawlers (a buff, a nerf, new Buffies): that brawler's games before `date`
   * ("YYYY-MM-DD", the day it went live) count `weightBefore` as much (default 0 = dropped), along
   * with its matchups and pairs. Everyone else's games are untouched. Names as in the game.
   */
  brawlerChanges?: Array<{ brawler: string; date: string; weightBefore?: number }>;
}

export function loadCollectorConfig(path: string = "config/collector.json"): CollectorConfig {
  return JSON.parse(readFileSync(path, "utf8")) as CollectorConfig;
}

export const RANK_NAMES = ["Bronze", "Silver", "Gold", "Diamond", "Mythic", "Legendary", "Masters"];

/** 1 -> "Bronze I", 15 -> "Mythic III", 22 -> "Pro". */
export function rankName(rank: number): string {
  if (rank >= 22) return "Pro";
  const tier = RANK_NAMES[Math.floor((rank - 1) / 3)];
  return tier ? `${tier} ${"I".repeat(((rank - 1) % 3) + 1)}` : `Rank ${rank}`;
}
