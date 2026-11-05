// One collector run. State lives in DATA_DIR (default ./data); in CI that's the `data` branch.
//   npm run collect
//   COLLECTOR_CONFIG=path/to/other.json npm run collect   (e.g. a short local test run)
import { mkdirSync } from "node:fs";
import { BrawlStarsClient } from "../src/api/client.js";
import { collect } from "../src/collector/collect.js";
import { loadCollectorConfig, rankName } from "../src/collector/config.js";
import { loadState, saveState } from "../src/collector/state.js";
import { apiConfigFromEnv } from "../src/config.js";

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR || "data";
  mkdirSync(dataDir, { recursive: true });
  const config = loadCollectorConfig(process.env.COLLECTOR_CONFIG || undefined);
  const client = new BrawlStarsClient(apiConfigFromEnv());
  const state = loadState(dataDir);

  console.log(`Collecting ranked draft games at ${rankName(config.minRank)}+ into ${dataDir}/`);
  const summary = await collect(client, state, config);
  saveState(dataDir, state);

  const totalGames = [...state.days.values()].reduce((n, d) => n + d.games, 0);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Window now holds ${totalGames} games across ${state.days.size} day(s).`);

  // Many logs but no ranked games almost always means the API changed shape or the filter is wrong.
  if (summary.logsFetched >= 50 && summary.rankedEntries === 0) {
    console.error(`✗ Fetched ${summary.logsFetched} logs but found no "${config.rankedBattleType}" games. Check the battle type in config/collector.json.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
