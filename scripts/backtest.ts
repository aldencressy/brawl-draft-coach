// Checks the engine against real results: for each day with a game sample, builds stats from the
// days before it and predicts that day's games. Run it after changing weights.json or the model.
//   npm run backtest                    every sampled day that has earlier days to learn from
//   npm run backtest -- --day 2026-11-07
// Reads DATA_DIR/days and DATA_DIR/games (default data/). To use the live data:
//   git clone -q --depth 1 --branch data https://github.com/aldencressy/brawl-draft-coach.git data
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import weightsJson from "../config/weights.json";
import type { DayAggregate } from "../src/collector/aggregate.js";
import { loadCollectorConfig } from "../src/collector/config.js";
import type { DaySample } from "../src/collector/sample.js";
import { fitWeights, gameParts, predict, score, type GameParts } from "../src/engine/backtest.js";
import type { Weights } from "../src/engine/types.js";
import type { StaticData } from "../src/outputs/static.js";
import { buildStats, resolveBrawlerChanges } from "../src/outputs/stats.js";

const dir = process.env.DATA_DIR || "data";
const weights = weightsJson as unknown as Weights;
const config = loadCollectorConfig(process.env.COLLECTOR_CONFIG || undefined);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const dated = <T>(folder: string) =>
  existsSync(join(dir, folder))
    ? readdirSync(join(dir, folder)).filter((f) => f.endsWith(".json")).sort().map((f) => readJson<T>(join(dir, folder, f)))
    : [];

const days = dated<DayAggregate>("days");
const samples = dated<DaySample>("games");
if (!samples.length) {
  console.error(`✗ No game samples in ${dir}/games. Clone the data branch (see the top of this file).`);
  process.exit(1);
}
const staticData = existsSync(join(dir, "out", "static.json")) ? readJson<StaticData>(join(dir, "out", "static.json")) : undefined;
const dayArg = process.argv.includes("--day") ? process.argv[process.argv.indexOf("--day") + 1] : undefined;
// Days with too little to learn from (the first day or two of collection) aren't worth testing.
const MIN_TRAIN_GAMES = 20_000;
const MIN_TEST_GAMES = 1_000;

const pts = (x: number) => (x * 1000).toFixed(2);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
let tested = 0;

for (const sample of samples) {
  if (dayArg && sample.date !== dayArg) continue;
  const train = days.filter((d) => d.date < sample.date);
  const trainGames = train.reduce((n, d) => n + d.games, 0);
  if (trainGames < MIN_TRAIN_GAMES || sample.games.length < MIN_TEST_GAMES) {
    if (dayArg) console.log(`${sample.date}: skipped (${trainGames} games to learn from, ${sample.games.length} to test)`);
    continue;
  }
  tested++;
  const stats = buildStats(train, config.minRank, new Date(Date.parse(sample.date) - 1), {
    recencyDecay: config.recencyDecay ?? 1,
    balanceChange: config.balanceChange ?? { date: null, weightBefore: 1 },
    brawlerChanges: staticData ? resolveBrawlerChanges(config.brawlerChanges, staticData.brawlers, (m) => console.warn(`  ! ${m}`)) : [],
  });
  const modeOf = (mapId: number) => stats.maps[mapId]?.mode ?? staticData?.maps.find((m) => m.id === mapId)?.mode ?? "";
  const games = gameParts(stats, modeOf, sample.games, weights);

  const engine = (g: GameParts) => predict(g);
  const coin = score(games, () => 0.5);
  const base = score(games, engine, () => 0.5);
  console.log(`\n${sample.date}: ${games.length.toLocaleString("en-US")} games, learned from ${trainGames.toLocaleString("en-US")} (${train[0]!.date} to ${train.at(-1)!.date})`);
  console.log(`  Engine     picks the winner ${pct(base.accuracy)} of the time · log loss ${base.loss.toFixed(4)} (coin flip ${coin.loss.toFixed(4)})`);
  console.log(`  Variants, change in log loss ×1000 against the engine (negative = better, ± one standard error):`);
  const variants: Array<[string, (g: GameParts) => number]> = [
    ["no counters", (g) => predict(g, { counter: 0 })],
    ["counters ×0.5", (g) => predict(g, { counter: 0.5 })],
    ["counters ×1.5", (g) => predict(g, { counter: 1.5 })],
    ["no pairs", (g) => predict(g, { synergy: 0 })],
    ["pairs ×0.5", (g) => predict(g, { synergy: 0.5 })],
    ["pairs ×2", (g) => predict(g, { synergy: 2 })],
    ["map with luck left in", (g) => predict(g, { rawMap: true })],
  ];
  for (const [name, pred] of variants) {
    const s = score(games, pred, engine);
    const verdict = Math.abs(s.diff) < 2 * s.se ? "no clear difference" : s.diff < 0 ? "BETTER" : "worse";
    console.log(`    ${name.padEnd(22)} ${pts(s.diff).padStart(7)} ± ${pts(s.se)}   ${verdict}`);
  }
  const fitted = fitWeights(games, ["map", "counter", "synergy"]);
  console.log(`  Best-fitting weights (1 = the engine's weight now): ${fitted.map((f) => `${f.key} ${f.weight.toFixed(2)} ± ${f.se.toFixed(2)}`).join(" · ")}`);
}

if (!tested) {
  console.error(`✗ No day to test${dayArg ? ` matching ${dayArg}` : ""}: each needs a game sample and at least ${MIN_TRAIN_GAMES.toLocaleString("en-US")} games on earlier days.`);
  process.exit(1);
}
