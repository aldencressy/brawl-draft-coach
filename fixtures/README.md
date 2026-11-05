# Fixtures

Synthetic API responses served by the mock server (`npm run mock`) and used by tests.
Regenerate with `npm run fixtures` (edit `generate.mjs` to change them).

Their shapes follow what `npm run inspect` found in real responses:

- Ranked draft games have `battle.type: "soloRanked"`; `"ranked"` is the trophy ladder.
- In `soloRanked` games, `brawler.trophies` is the player's rank (13–15 Mythic, 16–18 Legendary).
- One draft is played as a set of 2–3 games with the same picks on the same map.
- Players with no recent battles return 404 for their battle log.

Contents:

- `players/9LQ0P.json`: the mock "my profile" (use `MY_TAG=#9LQ0P` against the mock).
- `battlelogs/*.json`: 12 ranked sets shared across 13 players (so dedupe has work to do), two
  players below Mythic, plus trophy-ladder 3v3, 5v5 and showdown games the filter should skip.
- `rankings/*.json`: seeds, including one tag per list with no battle log.
