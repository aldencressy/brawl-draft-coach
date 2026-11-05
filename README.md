# Brawl Draft Coach

Live drafting coach for Brawl Stars ranked. A collector gathers ranked match stats on a schedule;
a static page suggests your best pick as you tap in the draft.

Status: **Milestone 2** (collector and hourly GitHub workflow).

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

## Collector on GitHub Actions

`.github/workflows/collect.yml` runs the collector hourly (and on demand from the Actions tab).

1. Add your key as a repository secret (the command prompts for it):
   ```bash
   gh secret set BS_API_KEY --repo aldencressy/brawl-draft-coach
   ```
2. Push. The first run creates the `data` branch; each run replaces it with a single commit,
   so the repo doesn't grow.
3. Optional: set a repository variable `BS_API_BASE` to use a different proxy.

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

## Without a key: mock server

```bash
npm run mock
```

Then, in another terminal:

```bash
BS_API_BASE=http://localhost:8787/v1 BS_API_KEY=mock MY_TAG=9LQ0P npm run verify-key
```

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

Static data, your roster, the JSON outputs and Pages setup come in later milestones.
