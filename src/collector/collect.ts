import { ApiError } from "../api/client.js";
import type { BattleLogEntry, Paged, RankedPlayer } from "../api/types.js";
import { addGame, emptyDay, pruneDays } from "./aggregate.js";
import type { CollectorConfig } from "./config.js";
import { toRankedGame } from "./games.js";
import { addPlayer, recordVisit, selectPlayers, trimPool } from "./pool.js";
import { emptySample, offerGame } from "./sample.js";
import type { CollectorState, RunSummary } from "./state.js";

/** The parts of BrawlStarsClient the collector uses, so tests can pass a fake. */
export interface LogSource {
  getBattleLog(tag: string): Promise<Paged<BattleLogEntry>>;
  getPlayerRankings(country: string, limit?: number): Promise<Paged<RankedPlayer>>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** One collector run: seed if due, crawl the highest-priority logs, aggregate new games, prune. Mutates `state`. */
export async function collect(
  source: LogSource,
  state: CollectorState,
  config: CollectorConfig,
  clock: () => number = Date.now,
  log: (msg: string) => void = console.log,
  random: () => number = Math.random,
): Promise<RunSummary> {
  const startedAt = clock();
  const deadline = startedAt + config.maxRunMinutes * 60_000;
  const summary: RunSummary = {
    startedAt: new Date(startedAt).toISOString(),
    seconds: 0,
    logsFetched: 0,
    logsEmpty: 0,
    logsFailed: 0,
    rankedEntries: 0,
    newGames: 0,
    duplicateGames: 0,
    belowMinRank: 0,
    tooOld: 0,
    poolSize: 0,
    poolTrimmed: 0,
    errors: {},
  };
  const seenKeys = new Set(Object.values(state.seen).flat());
  // Games older than the dedupe memory can't be checked for duplicates, so they're skipped.
  const seenCutoff = new Date(startedAt - (config.seenKeyDays - 1) * DAY).toISOString().slice(0, 10);

  if (startedAt - state.pool.seededAt >= config.seedEveryHours * HOUR) {
    for (const country of config.seedCountries) {
      try {
        const ranking = await source.getPlayerRankings(country, 200);
        ranking.items.forEach((p) => addPlayer(state.pool, p.tag, startedAt));
        log(`Seeded ${ranking.items.length} players from ${country} ranking`);
      } catch (err) {
        log(`Seeding from ${country} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    state.pool.seededAt = startedAt;
  }

  const queue = selectPlayers(state.pool, startedAt, config.maxLogsPerRun);
  log(`Crawling up to ${queue.length} of ${Object.keys(state.pool.players).length} players`);

  const visit = async (tag: string) => {
    let items: BattleLogEntry[];
    try {
      items = (await source.getBattleLog(tag)).items;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // No recent battles: not an error, just nothing to collect.
        summary.logsEmpty++;
        recordVisit(state.pool, tag, clock(), 0);
      } else {
        summary.logsFailed++;
        const reason = err instanceof ApiError ? `${err.status} ${err.reason ?? ""}`.trim() : "network";
        summary.errors[reason] = (summary.errors[reason] ?? 0) + 1;
      }
      return;
    }
    summary.logsFetched++;

    let yieldCount = 0;
    for (const entry of items) {
      const game = toRankedGame(entry, tag, config.rankedBattleType);
      if (!game) continue;
      summary.rankedEntries++;
      if (game.day < seenCutoff) {
        summary.tooOld++;
        continue;
      }
      if (game.avgRank < config.minRank) {
        summary.belowMinRank++;
        continue;
      }
      yieldCount++;
      game.playerTags.forEach((t) => addPlayer(state.pool, t, game.time));
      if (seenKeys.has(game.key)) {
        summary.duplicateGames++;
        continue;
      }
      seenKeys.add(game.key);
      (state.seen[game.day] ??= []).push(game.key);
      if (!state.days.has(game.day)) state.days.set(game.day, emptyDay(game.day));
      addGame(state.days.get(game.day)!, game);
      if (config.sampleGamesPerDay) {
        if (!state.samples.has(game.day)) state.samples.set(game.day, emptySample(game.day));
        offerGame(state.samples.get(game.day)!, game, config.sampleGamesPerDay, random);
      }
      summary.newGames++;
    }
    recordVisit(state.pool, tag, clock(), yieldCount);
  };

  // A few workers pull from the shared queue; the API client's rate limiter paces them.
  let next = 0;
  const worker = async () => {
    while (next < queue.length && clock() < deadline) await visit(queue[next++]!);
  };
  await Promise.all(Array.from({ length: config.concurrency }, worker));
  if (next < queue.length) log(`Time budget reached after ${next} of ${queue.length} logs`);

  const today = new Date(clock()).toISOString().slice(0, 10);
  for (const date of pruneDays([...state.days.keys()], today, config.windowDays).drop) state.days.delete(date);
  for (const date of pruneDays([...state.samples.keys()], today, config.windowDays).drop) state.samples.delete(date);
  for (const date of Object.keys(state.seen)) if (date < seenCutoff) delete state.seen[date];

  summary.poolTrimmed = trimPool(state.pool, config.poolCap);
  summary.poolSize = Object.keys(state.pool.players).length;
  summary.seconds = Math.round((clock() - startedAt) / 1000);
  state.runs.push(summary);
  return summary;
}
