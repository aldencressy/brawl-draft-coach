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
