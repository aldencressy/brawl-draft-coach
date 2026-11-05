// Checks that BS_API_KEY works through BS_API_BASE (the RoyaleAPI proxy by default).
//   npm run verify-key
import { ApiError, BrawlStarsClient } from "../src/api/client.js";
import { apiConfigFromEnv, myTagFromEnv } from "../src/config.js";

async function main(): Promise<void> {
  const config = apiConfigFromEnv();
  const client = new BrawlStarsClient(config, { maxRetries: 2 });
  console.log(`Using ${config.baseUrl}`);

  const rankings = await client.getPlayerRankings("global", 1);
  const top = rankings.items[0];
  console.log(`✓ Key works. Global #1: ${top?.name ?? "?"} (${top?.tag ?? "?"})`);

  const myTag = myTagFromEnv();
  if (!myTag) {
    console.log("• MY_TAG is not set, so your profile wasn't checked. Add it to .env (in-game: tap your profile; the tag starts with #).");
    return;
  }
  const me = await client.getPlayer(myTag);
  const ranked11 = me.brawlers.filter((b) => b.power >= 11).length;
  console.log(`✓ Found you: ${me.name} (${me.tag}), ${me.brawlers.length} brawlers owned, ${ranked11} at power 11.`);
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof ApiError || err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
