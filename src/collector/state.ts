// Collector state on disk. In CI this directory is the `data` branch.
//   pool.json            players to crawl
//   seen.json            { day: [gameKey...] } for dedupe across runs
//   days/<date>.json     one DayAggregate per UTC day
//   games/<date>.json    a random sample of that day's games, kept whole (see sample.ts)
//   meta.json            recent run summaries
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyDay, type DayAggregate } from "./aggregate.js";
import { emptyPool, type Pool } from "./pool.js";
import { emptySample, type DaySample } from "./sample.js";

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
  samples: Map<string, DaySample>;
  runs: RunSummary[];
}

const MAX_RUN_HISTORY = 72;

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

/** Every `<date>.json` in a folder, keyed by date. */
function readDated<T extends { date: string }>(folder: string, empty: (date: string) => T): Map<string, T> {
  const out = new Map<string, T>();
  if (!existsSync(folder)) return out;
  for (const file of readdirSync(folder).filter((f) => f.endsWith(".json"))) {
    const item = readJson<T>(join(folder, file), empty(file.replace(".json", "")));
    out.set(item.date, item);
  }
  return out;
}

function writeDated(folder: string, items: Iterable<{ date: string }>): void {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const item of items) writeFileSync(join(folder, `${item.date}.json`), JSON.stringify(item));
}

export function loadState(dir: string): CollectorState {
  return {
    pool: readJson(join(dir, "pool.json"), emptyPool()),
    seen: readJson(join(dir, "seen.json"), {}),
    days: readDated(join(dir, "days"), emptyDay),
    samples: readDated(join(dir, "games"), emptySample),
    runs: readJson<{ runs: RunSummary[] }>(join(dir, "meta.json"), { runs: [] }).runs,
  };
}

export function saveState(dir: string, state: CollectorState): void {
  writeDated(join(dir, "days"), state.days.values());
  writeDated(join(dir, "games"), state.samples.values());
  writeFileSync(join(dir, "pool.json"), JSON.stringify(state.pool));
  writeFileSync(join(dir, "seen.json"), JSON.stringify(state.seen));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runs: state.runs.slice(-MAX_RUN_HISTORY) }, null, 2));
}
