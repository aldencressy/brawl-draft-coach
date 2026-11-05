import { describe, expect, it } from "vitest";
import { collect } from "../src/collector/collect.js";
import type { CollectorConfig } from "../src/collector/config.js";
import { toRankedGame } from "../src/collector/games.js";
import { emptyPool } from "../src/collector/pool.js";
import type { CollectorState } from "../src/collector/state.js";
import { allFixtureEntries, fixtureSource } from "./helpers.js";

const config: CollectorConfig = {
  rankedBattleType: "soloRanked",
  minRank: 13,
  seedCountries: ["global", "US"],
  seedEveryHours: 24,
  poolCap: 1000,
  maxLogsPerRun: 1000,
  maxRunMinutes: 8,
  concurrency: 3,
  windowDays: 7,
  seenKeyDays: 3,
  recencyDecay: 1,
  balanceChange: { date: null, weightBefore: 0 },
};

const HOUR = 3_600_000;
const freshState = (): CollectorState => ({ pool: emptyPool(), seen: {}, days: new Map(), runs: [] });

// Games every fixture log could contribute, deduped, at Mythic+.
const expected = new Set<string>();
for (const { owner, entry } of allFixtureEntries()) {
  const game = toRankedGame(entry, owner, "soloRanked");
  if (game && game.avgRank >= 13) expected.add(game.key);
}

describe("collect", () => {
  it("crawls outward from the seeds and stores each game once", async () => {
    const state = freshState();
    let now = Date.UTC(2026, 10, 5, 13, 0, 0);
    const clock = () => now;
    const source = fixtureSource();

    const first = await collect(source, state, config, clock, () => {});
    expect(first.logsEmpty).toBe(2); // the two seed tags with no battle log
    expect(first.duplicateGames).toBeGreaterThan(0);
    expect(first.belowMinRank).toBeGreaterThan(0);

    // Players discovered in the first run are crawled in the next one.
    now += 2 * HOUR;
    const second = await collect(source, state, config, clock, () => {});

    const totalNew = first.newGames + second.newGames;
    expect(totalNew).toBe(expected.size);
    const stored = [...state.days.values()].reduce((n, d) => n + d.games, 0);
    expect(stored).toBe(expected.size);
    expect(Object.values(state.seen).flat()).toHaveLength(expected.size);

    // A third run finds nothing new.
    now += 2 * HOUR;
    const third = await collect(source, state, config, clock, () => {});
    expect(third.newGames).toBe(0);
  });

  it("drops days outside the window and old dedupe keys", async () => {
    const state = freshState();
    state.days.set("2026-10-01", { date: "2026-10-01", games: 5, maps: {}, modes: {} });
    state.seen["2026-10-01"] = ["old"];
    await collect(fixtureSource(), state, config, () => Date.UTC(2026, 10, 5, 13), () => {});
    expect(state.days.has("2026-10-01")).toBe(false);
    expect(state.seen["2026-10-01"]).toBeUndefined();
  });

  it("stops at the time budget", async () => {
    const state = freshState();
    let now = Date.UTC(2026, 10, 5, 13);
    const source = fixtureSource();
    const slow = { ...source, getBattleLog: async (tag: string) => { now += 5 * 60_000; return source.getBattleLog(tag); } };
    const summary = await collect(slow, state, { ...config, concurrency: 1 }, () => now, () => {});
    expect(summary.logsFetched + summary.logsEmpty).toBe(2);
  });
});
