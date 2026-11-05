# Brawl Draft Coach

Live drafting coach for Brawl Stars ranked. A collector gathers ranked match stats on a schedule;
a static page suggests your best pick as you tap in the draft.

Status: **Milestone 5** (draft UI on GitHub Pages).

**Open the coach:** https://aldencressy.github.io/brawl-draft-coach/

## Setup

Requires Node 18.18+ (20 or 22 recommended).

```bash
npm install
cp .env.example .env
```

### 1. Get a Brawl Stars API key

1. Go to https://developer.brawlstars.com and create an account (any email; it isn't linked to your game account).
2. Open **My Account → Create New Key**.
3. Give it a name and description, and under **Allowed IP Addresses** enter `45.79.218.79`.
   That's the RoyaleAPI proxy, which we call instead of the official API, because Supercell keys
   only work from fixed IPs and GitHub Actions' IPs change.
4. Create the key, then copy the long token into `.env` as `BS_API_KEY`.

### 2. Add your player tag

In game, tap your profile; your tag starts with `#`. Put it in `.env` as `MY_TAG`.

### 3. Check it works

```bash
npm run verify-key
```

### 4. Inspect real data

```bash
npm run inspect
```

Pulls 50 battle logs from the global ranking and reports battle types, modes, available fields
and how many unique ranked matches were found. Raw responses go to `samples/` (gitignored).
Options: `--players 100`, `--country US`.

### 5. Run the collector locally (optional)

```bash
npm run collect
```

Crawls battle logs and writes state to `data/` (gitignored). Each run seeds from the rankings
once a day, visits the highest-priority players, and adds new ranked draft games to that day's
totals. Set `DATA_DIR` to write somewhere else, or `COLLECTOR_CONFIG` to use a different config.

### 6. Build the UI's data files (optional)

```bash
npm run outputs
```

Writes `data/out/stats.json`, `static.json` and `roster.json` (see [Outputs](#outputs)).

## Collector on GitHub Actions

`.github/workflows/collect.yml` runs the collector hourly (and on demand from the Actions tab).

1. Add your key as a repository secret (the command prompts for it):
   ```bash
   gh secret set BS_API_KEY --repo aldencressy/brawl-draft-coach
   ```
2. Push. The first run creates the `data` branch; each run replaces it with a single commit,
   so the repo doesn't grow.
3. Set your player tag as a repository variable (it's public in-game, so not a secret):
   ```bash
   gh variable set MY_TAG --body "#YOURTAG" --repo aldencressy/brawl-draft-coach
   ```
4. Optional: set a repository variable `BS_API_BASE` to use a different proxy.

Each run's summary is in the Actions log and in `meta.json` on the `data` branch.
A run fails (red) if it fetched many logs but found no ranked games, which usually means the API
changed.

GitHub disables scheduled workflows in public repos after 60 days without repository activity.
It emails a warning first; re-enable from the Actions tab if that happens.

### What the collector keeps

- **Ranked draft only:** `battle.type == "soloRanked"`, two teams of three. (`"ranked"` is the
  trophy ladder.)
- **Mythic and above:** the average rank of the six players must be at least `minRank`. In ranked
  games the API puts each player's rank in `brawler.trophies`: 13–15 Mythic, 16–18 Legendary,
  19–21 Masters.
- **Each game once:** a game appears in up to six players' logs; it's identified by its time and
  players. One draft is played as a set of 2–3 games, and each game counts separately.
- **Totals, not raw games:** per UTC day, `days/<date>.json` holds per-map brawler games and
  wins, plus per-mode matchups (`vs`) and teammate pairs (`with`). Days older than `windowDays`
  are dropped.

### Player pool

Seeded from the `seedCountries` rankings and grown with everyone seen in a qualifying game.
Battle logs only cover the last ~2 hours for active players, so players who had ranked games
on their last visit are revisited sooner. Over `poolCap`, the least productive players are
dropped.

## Outputs

Each run writes these to `out/` on the `data` branch:

- **`stats.json`**: ranked games over the window.
  - `maps[mapId]`: games on the map, and `brawlers[id] = [games, wins]`.
  - `modes[mode]` and `overall` (all modes combined): `brawlers`, plus `vs["a-b"] = [games, wins for a]`
    (a is the lower id) and `with["a-b"] = [games, wins together]`.
  - `currentMaps`: maps played in the last 2 days, most played first.
  - `window`, `games`, `minRank`, `generatedAt`.
- **`static.json`**: every brawler with display name, class, image, roles, gadgets and star powers
  (with descriptions), hypercharges, gears and its `build`; plus ranked maps and modes.
- **`roster.json`**: your brawlers (power and owned items) with your ranked games and wins on each,
  your current rank and Elo, and your 50 most recent ranked games.

Sources:

- **Official API `/brawlers`** decides which brawlers and items exist, so new brawlers show up
  immediately.
- **BrawlAPI** adds names, classes, images, descriptions and maps. Refreshed weekly
  (`cache/brawlapi.json`); if it's down, the cached copy is used.
- **`config/roles.json`** (edit me): each brawler gets the roles for its class, plus any you list for
  it by name.
- **`config/builds.json`** (edit me): recommended builds by item name. Battle logs don't record
  builds, so these are hand-written.
- **Your battle log**: fetched every run; your ranked games accumulate in `me.json` with no time
  limit.

`npm run outputs` warns about names in `roles.json` or `builds.json` that don't match anything.

## Draft UI

A static page (`web/`) that loads `stats.json`, `static.json` and `roster.json` once, then runs the
scoring engine in the browser on every entry. Built for a computer beside your phone; it also
works at phone width.

**Setup:** type part of the map name and press <kbd>Enter</kbd> (current ranked maps are listed
first), then press <kbd>1</kbd>–<kbd>6</kbd> for your pick slot.

**Entering the draft:** focus stays in the search box. Type a few letters and press
<kbd>Enter</kbd>; the brawler goes where the draft expects next:

- **Bans** first. After 6 they close automatically; press <kbd>Enter</kbd> on an empty box to end
  them early (duplicate bans).
- **Picks** then follow the draft order from your side, including your own pick.
- Override where an entry goes with a prefix (`-crow` enemy, `+gene` ally, `!colt` ban), with
  <kbd>Tab</kbd>, or with the Ban / Ally / Enemy buttons.
- <kbd>↑</kbd>/<kbd>↓</kbd> choose among matches, <kbd>Esc</kbd> clears, <kbd>Ctrl</kbd>+<kbd>Z</kbd>
  undoes. Click a placed brawler or ban to remove it. Clicking a portrait also adds it.

The draft is saved in the browser on every entry, so a refresh doesn't lose it.

**Suggestions** for your slot update on every entry: score, reasons, warning, build and the score
breakdown, plus the next five. After you lock in, your pick is marked with where it ranked.

**Draft log:** each draft with your pick is saved in the browser: map, slot, bans, picks, your
pick and the suggestions at that moment. "Export draft log" downloads it as JSON, for checking later
whether following the coach wins.

**Deployment:** every workflow run builds the page with that run's JSON and deploys it to Pages,
so the site and its data always match. Pushes that change `web/`, `src/engine/` or `config/` also
trigger a run, so UI and weight changes go live within minutes. One-time setup: in the repo's
**Settings → Pages**, set **Source** to **GitHub Actions**.

**Local development:**

```bash
git clone -q --depth 1 --branch data https://github.com/aldencressy/brawl-draft-coach.git data
npm run dev        # http://localhost:5173, serving data/out/ at /data/
npm run build:web  # dist/ with the JSON copied in; `npm run preview` serves it
```

## Scoring

`recommend(draft, data, weights, draftConfig)` in `src/engine/recommend.ts` is a pure function:
given the map, your pick slot, bans, ally picks and enemy picks, it scores every brawler you own
that's still available. Scores are in **win-rate points** (+1 = one percentage point).

| Part | What it measures |
|---|---|
| `map` | Smoothed win rate on this map, minus 50% |
| `counter` | Average edge against each enemy already picked |
| `synergy` | Average edge with each ally already picked |
| `risk` | How hard the worst counters still open to the enemy beat it, scaled by enemy picks left after yours |
| `role` | Fills a role your team lacks, duplicates one it has, or answers an enemy role (`roles` in weights) |
| `comfort` | How much better you do on it than everyone else (from your own ranked games) |

Each part is multiplied by its weight for your pick slot (`byPick` in `config/weights.json`) and
summed. Early picks lean on map strength and low risk; the last pick leans on counters.

**Smoothing.** Win rates are smoothed with `(wins + k × prior) / (games + k)`. The prior for a map
rate is the brawler's rate on the mode's *other* maps; for that, its rate in *other* modes; then 50%.
Using only outside games means no game counts twice. `k` values are in `smoothing`; they're high
because one draft is played as 2–3 games.

**Edges, not raw win rates.** A strong brawler beats most enemies, so a matchup only counts as a
counter if it beats what the two brawlers' own win rates predict. Same for teammate pairs.

**Output** (`Recommendation` in `src/engine/types.ts`) is plain JSON: the draft context, data
freshness, and the top `handOffTop` candidates, each with its score, the parts, up to three reason
tags, a warning (thin data or a dangerous counter), the build from `builds.json`, and the details
behind each part. The UI shows the first `showTop`; the AI layer (Milestone 6) will get all of them.

**Draft order** is in `config/draft.json`: which team makes each of the six picks.

### Trying it from the terminal

```bash
git clone -q --depth 1 --branch data https://github.com/aldencressy/brawl-draft-coach.git data
npm run suggest                                   # lists current ranked maps
npm run suggest -- --map "hard rock" --slot 6 --ally gene,emz --enemy mortis,crow,bull --ban colt,spike
```

Add `--json` to see the full output. To refresh the data later: `rm -rf data` and clone again.

## Without a key: mock server

```bash
npm run mock
```

Then, in another terminal:

```bash
BS_API_BASE=http://localhost:8787/v1 BS_API_KEY=mock MY_TAG=9LQ0P npm run verify-key
```

For `npm run outputs`, also set `BRAWLAPI_BASE=http://localhost:8787/brawlapi/v1`.

`MOCK_FLAKY=1 npm run mock` makes every third request fail, to exercise retries.
Fixture data in `fixtures/` is synthetic (`npm run fixtures` regenerates it); see `fixtures/README.md`.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `BS_API_KEY` | — | Your API key |
| `BS_API_BASE` | `https://bsproxy.royaleapi.dev/v1` | API base URL (proxy, or the mock) |
| `MY_TAG` | — | Your player tag, for the roster |
| `BS_RATE_LIMIT_RPS` | `8` | Max requests per second |

Collector settings are in `config/collector.json`:

| Setting | Default | Purpose |
|---|---|---|
| `rankedBattleType` | `soloRanked` | `battle.type` of ranked draft games |
| `minRank` | `13` | Minimum average rank (13 = Mythic I) |
| `seedCountries` | `["global", "US"]` | Rankings used to seed the pool |
| `seedEveryHours` | `24` | How often to re-seed |
| `poolCap` | `20000` | Max players in the pool |
| `maxLogsPerRun` | `3000` | Battle logs per run |
| `maxRunMinutes` | `8` | Time budget per run |
| `concurrency` | `6` | Logs fetched in parallel (still within the rate limit) |
| `windowDays` | `7` | Days of totals kept |
| `seenKeyDays` | `3` | Days of game IDs kept for dedupe |

## Development

```bash
npm test          # unit tests
npm run typecheck
```

The AI layer comes in Milestone 6.
