import { readFileSync, readdirSync } from "node:fs";
import { ApiError } from "../src/api/client.js";
import type { BattleLogEntry, Paged, RankedPlayer } from "../src/api/types.js";
import type { LogSource } from "../src/collector/collect.js";

export function fixtureLog(tag: string): Paged<BattleLogEntry> {
  return JSON.parse(readFileSync(`fixtures/battlelogs/${tag.replace(/^#/, "")}.json`, "utf8"));
}

export function allFixtureEntries(): Array<{ owner: string; entry: BattleLogEntry }> {
  return readdirSync("fixtures/battlelogs").flatMap((file) =>
    fixtureLog(file.replace(".json", "")).items.map((entry) => ({ owner: `#${file.replace(".json", "")}`, entry })),
  );
}

/** Serves fixture files like the API would, including 404 for unknown players. */
export function fixtureSource(): LogSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getBattleLog(tag) {
      calls.push(tag);
      try {
        return fixtureLog(tag);
      } catch {
        throw new ApiError("Not found", 404, "notFound", tag);
      }
    },
    async getPlayerRankings(country) {
      return JSON.parse(readFileSync(`fixtures/rankings/${country}.json`, "utf8")) as Paged<RankedPlayer>;
    },
  };
}
