// Collector state on disk. In CI this directory is the `data` branch.
//   pool.json            players to crawl
//   seen.json            { day: [gameKey...] } for dedupe across runs
//   days/<date>.json     one DayAggregate per UTC day
//   meta.json            recent run summaries
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyDay, type DayAggregate } from "./aggregate.js";
import { emptyPool, type Pool } from "./pool.js";

export interface RunSummary {
  startedAt: string;
  seconds: number;
  logsFetched: number;
  logsEmpty: number;
  logsFailed: number;
  rankedEntries: number;
  newGames: number;
  duplicateGames: number;
  belowMinRank: number;
  tooOld: number;
  poolSize: number;
  poolTrimmed: number;
  errors: Record<string, number>;
}

export interface CollectorState {
  pool: Pool;
  seen: Record<string, string[]>;
  days: Map<string, DayAggregate>;
  runs: RunSummary[];
}

const MAX_RUN_HISTORY = 72;

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

export function loadState(dir: string): CollectorState {
  const days = new Map<string, DayAggregate>();
  const daysDir = join(dir, "days");
  if (existsSync(daysDir)) {
    for (const file of readdirSync(daysDir).filter((f) => f.endsWith(".json"))) {
      const day = readJson<DayAggregate>(join(daysDir, file), emptyDay(file.replace(".json", "")));
      days.set(day.date, day);
    }
  }
  return {
    pool: readJson(join(dir, "pool.json"), emptyPool()),
    seen: readJson(join(dir, "seen.json"), {}),
    days,
    runs: readJson<{ runs: RunSummary[] }>(join(dir, "meta.json"), { runs: [] }).runs,
  };
}

export function saveState(dir: string, state: CollectorState): void {
  const daysDir = join(dir, "days");
  rmSync(daysDir, { recursive: true, force: true });
  mkdirSync(daysDir, { recursive: true });
  for (const day of state.days.values()) {
    writeFileSync(join(daysDir, `${day.date}.json`), JSON.stringify(day));
  }
  writeFileSync(join(dir, "pool.json"), JSON.stringify(state.pool));
  writeFileSync(join(dir, "seen.json"), JSON.stringify(state.seen));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runs: state.runs.slice(-MAX_RUN_HISTORY) }, null, 2));
}
