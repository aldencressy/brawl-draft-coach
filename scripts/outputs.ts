// Builds the JSON files the draft UI reads, into DATA_DIR/out/:
//   stats.json   ranked stats over the window, from the collector's daily totals
//   static.json  brawlers (roles, items, builds), maps and modes
//   roster.json  your brawlers and ranked history (needs MY_TAG)
// Also refreshes the BrawlAPI cache when it's over a week old, and adds your new ranked games.
//   npm run outputs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrawlStarsClient } from "../src/api/client.js";
import { loadCollectorConfig } from "../src/collector/config.js";
import { loadState } from "../src/collector/state.js";
import { apiConfigFromEnv, myTagFromEnv } from "../src/config.js";
import { DEFAULT_BRAWLAPI_BASE, fetchBrawlApi, isStale, type BrawlApiData } from "../src/outputs/brawlapi.js";
import { buildRoster, emptyMe, updateMe, type MeState } from "../src/outputs/me.js";
import { buildStatic, type BuildsConfig, type RolesConfig } from "../src/outputs/static.js";
import { buildStats } from "../src/outputs/stats.js";

const BRAWLAPI_MAX_AGE_DAYS = 7;

const readJson = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;

function writeOut(dir: string, name: string, data: unknown): void {
  const path = join(dir, name);
  const json = JSON.stringify(data);
  writeFileSync(path, json);
  console.log(`  ${name}: ${(json.length / 1024).toFixed(0)} KB`);
}

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR || "data";
  const outDir = join(dataDir, "out");
  mkdirSync(join(dataDir, "cache"), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const config = loadCollectorConfig(process.env.COLLECTOR_CONFIG || undefined);
  const client = new BrawlStarsClient(apiConfigFromEnv());

  // Static data
  const cachePath = join(dataDir, "cache", "brawlapi.json");
  let brawlApi = readJson<BrawlApiData>(cachePath);
  if (isStale(brawlApi, now, BRAWLAPI_MAX_AGE_DAYS)) {
    try {
      brawlApi = await fetchBrawlApi(process.env.BRAWLAPI_BASE || DEFAULT_BRAWLAPI_BASE, now);
      writeFileSync(cachePath, JSON.stringify(brawlApi));
      console.log(`Refreshed BrawlAPI data (${brawlApi.brawlers.length} brawlers)`);
    } catch (err) {
      console.warn(`${err instanceof Error ? err.message : err}. ${brawlApi ? "Keeping the cached copy." : "Continuing without it."}`);
    }
  }
  const official = (await client.getBrawlers()).items;
  const roles = readJson<RolesConfig>("config/roles.json") ?? { fromClass: {}, brawlers: {} };
  const builds = readJson<BuildsConfig>("config/builds.json") ?? { brawlers: {} };
  const staticData = buildStatic(official, brawlApi, roles, builds, now, (m) => console.warn(`  ! ${m}`));

  // Stats
  const state = loadState(dataDir);
  const stats = buildStats([...state.days.values()], config.minRank, now);

  // You
  const myTag = myTagFromEnv();
  let roster;
  if (myTag) {
    const player = await client.getPlayer(myTag);
    const mePath = join(dataDir, "me.json");
    const me = readJson<MeState>(mePath) ?? emptyMe(player.tag);
    const log = (await client.getBattleLog(player.tag)).items;
    const added = updateMe(me, log, config.rankedBattleType, config.seenKeyDays, now);
    writeFileSync(mePath, JSON.stringify(me));
    roster = buildRoster(player, me, now);
    console.log(`${player.name}: ${player.rankedRankName ?? "unranked"}, ${added} new ranked game(s) recorded`);
  } else {
    console.warn("MY_TAG is not set; skipping roster.json.");
  }

  console.log(`Writing ${outDir}/ (${stats.games} games, ${stats.window.from} to ${stats.window.to})`);
  writeOut(outDir, "stats.json", stats);
  writeOut(outDir, "static.json", staticData);
  if (roster) writeOut(outDir, "roster.json", roster);
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
