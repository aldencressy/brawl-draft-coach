# Brawl Draft Coach

Live drafting coach for Brawl Stars ranked. A collector gathers ranked match stats on a schedule;
a static page suggests your best pick as you tap in the draft.

Status: **Milestone 6** (AI second opinion).

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
- **Totals:** per UTC day, `days/<date>.json` holds per-map brawler games and wins, plus per-mode
  matchups (`vs`) and teammate pairs (`with`). Days older than `windowDays` are dropped.
- **A sample of whole games:** `games/<date>.json` keeps up to `sampleGamesPerDay` of each day's
  games whole, picked uniformly from the whole day (reservoir sampling). Each row is the time, map,
  winner, the six brawlers in the order the API lists them, where the log's owner sits in that
  order, and each player's rank (`fields` in the file names them). The totals can't answer two
  things this can: whether the API lists each team in pick order, and how well the engine predicts
  real results (a backtest). Same window as the totals.

### Player pool

Seeded from the `seedCountries` rankings and grown with everyone seen in a qualifying game.
Battle logs only cover the last ~2 hours for active players, so players who had ranked games
on their last visit are revisited sooner. Over `poolCap`, the least productive players are
dropped.

## Outputs

Each run writes these to `out/` on the `data` branch:

- **`stats.json`**: ranked games over the window, weighted by day (`recencyDecay`,
  `balanceChange`, `brawlerChanges`), so its counts are weighted games; `games` is the raw total
  and `effectiveGames` the weighted one.
  - `maps[mapId]`: games on the map, and `brawlers[id] = [games, wins]`.
  - `modes[mode]` and `overall` (all modes combined): `brawlers`, plus `vs["a-b"] = [games, wins for a]`
    (a is the lower id) and `with["a-b"] = [games, wins together]`.
  - `currentMaps`: maps played in the last 2 days, most played first.
  - `exposure` (only with `brawlerChanges`): for each changed brawler, the weighted games it could
    have been in, per map and mode, so its pick rate isn't lowered by its discounted older games.
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
- **`config/builds.json`**: recommended builds by item name for your 57 power-11 brawlers. Battle
  logs don't record builds, so these come from community build data: the most-picked gadget, star
  power and two gears on [noff.gg](https://www.noff.gg/brawl-stars/builds) (November 2026), with
  close seconds as `alternatives`. Edit any you play differently; refresh them after big balance
  changes.
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
<kbd>Enter</kbd>; the brawler goes where the draft expects next, following the pick order from
your side, including your own pick.

- **Only the bans that matter, one tap each.** The draft starts at picks, and nothing waits on
  bans. While the enemy still has picks after yours, the panel tries the bans that could change
  your pick and shows only those, above the suggestions: "If banned: Colt → Brock #1" means that if
  Colt is banned, Brock becomes the top pick (banning Colt takes away the enemy's answer to him).
  Tap a chip if that brawler really is banned; the suggestions and chips update. The #1 suggestion
  has its own "If banned → …" button. At the last pick bans can't change the answer, so none are
  shown. To record any other ban, type it with `!`, e.g. `!colt`.
- Override where an entry goes with a prefix (`-crow` enemy, `+gene` ally), with <kbd>Tab</kbd>,
  or with the Ally / Enemy buttons.
- <kbd>↑</kbd>/<kbd>↓</kbd> choose among matches, <kbd>Esc</kbd> clears, <kbd>Ctrl</kbd>+<kbd>Z</kbd>
  undoes. Click a placed brawler or ban to remove it. Clicking a portrait also adds it.

The draft is saved in the browser on every entry, so a refresh doesn't lose it.

**Suggestions** for your slot update on every entry: score, reasons, warning, the brawler's win
rate, games and pick rate on the map, the score breakdown, and its build:

- **Gadget** and **Star power**: all of its options, with the recommended one in gold and a close
  second dashed. Hover an item for its description.
- **Best counter to their team** (once the enemy has picked): the brawler with the biggest matchup
  edge against all their picks, with where it ranks overall, so a pure counter pick is always in
  view. The ranking itself weighs matchups and map strength the way real results do (see Backtest).
- **Likely answers** (early picks): the enemy's likeliest picks after yours that do well against
  it, with how many points each costs you.
- **Gears**: the two recommended ones, plus Hypercharge if you own it.
- Items you don't own are struck through, with a note if the recommended build needs one.

After you lock in, the panel moves on to your **teammate's next pick** ("Teammate's pick (pick 5)"),
so you can call one out for them. It updates as picks and bans come in, considers every brawler
(not just the ones you own), and leaves out your own record and items. Ban chips work the same way.
Once your team has all three picks, the panel goes back to your own suggestions as they were when
you picked, with your pick marked and where it ranked. That snapshot is also what the draft log
keeps. The AI second opinion stays on your own pick.

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

## AI second opinion

A card above the suggestions asks Claude to judge the engine's top 10 with what the numbers can't
see: team composition, how the map plays, what the enemy's remaining picks will target. It answers
with its best 3–5 (each with a short note and its stats rank), a one-line warning, and a one-line
summary. It only chooses among the engine's candidates; anything else in its answer is dropped.

- **Key:** paste an Anthropic API key into the card (from console.anthropic.com). It's stored only
  in that browser's local storage and sent only to `api.anthropic.com`; it never goes into the repo
  or the site. "Remove key" deletes it.
- **When it runs:** automatically once picks start, until you've made your pick. Each draft change
  cancels the previous request and starts a new one after a short pause (`debounceMs`), so the
  answer always matches the current board. "Ask now" works during bans; untick "Ask automatically"
  to only ask on demand. After you pick, the answer you picked with stays on screen.
- **Never blocking:** the engine's suggestions show instantly as before; the AI card fills in a few
  seconds later. Errors (bad key, rate limit, network) show in the card with a retry button.
- **Draft log:** the AI's ranking at your pick is logged next to the engine's (`aiSuggested`).
- **Settings** in `config/ai.json`: `model` (default `claude-opus-5-5`; `claude-haiku-5-5` is much
  faster and far cheaper), `effort` (`low` by default, for speed), `candidates` (how many of the
  engine's picks it sees), `maxTokens`, `debounceMs`.
- **Cost:** about 3,400 input tokens per request. With Opus 5.5 at low effort, roughly 2–5¢ per
  request, so roughly 5–20¢ per draft depending on how many picks come before yours. Haiku 5.5
  is around a tenth of a cent per request.
- **Refusals:** requests opt into server-side fallbacks (`fallbacks: "default"`), so if a safety
  classifier declines, the API retries on Anthropic's recommended model.

The prompt and the answer validation live in `src/ai/prompt.ts` (pure, tested in `test/ai.test.ts`);
the browser call is in `web/src/ai.ts`.

## Scoring

`recommend(draft, data, weights, draftConfig)` in `src/engine/recommend.ts` is a pure function:
given the map, your pick slot, bans, ally picks and enemy picks, it scores every brawler you own
at `minPower` or above (default 11) that's still available. Scores are in **win-rate points**
(+1 = one percentage point).

**Every pick is judged the same way: by its own part in the completed 3v3.** That's its strength
on the map plus its pair effect with every enemy and every teammate on the final board. For a
last pick the board is known. For earlier picks the rest of the draft is played out: each
remaining pick, in draft order, goes to the side that owns it, which takes the brawler worth most
to it (strength plus pairs with its team and matchups against the other), from brawlers actually
played on the map. A strong brawler that's easy to answer therefore scores lower as a first pick
than as a last pick, because the enemy gets to answer it.

**The enemy's picks follow the meta.** Real players don't always take the best answer; most pick
what's popular. So each enemy pick still to come is a spread over the brawlers they could take:
each starts from how often it's picked on this map, and the more it suits the board (counters your
team, pairs with theirs), the likelier it gets. A pick worth x more on this board is
e^(`answerFocus` × x) times as likely, so a hard counter is likely to be taken and a one-point
edge barely changes the odds. Your pick is judged against that spread, so it gains for beating
the current meta and loses for having a popular counter. Example: on Hideout, Colt beats Brock by
about 5 points and is in 11% of games, so a first-pick Brock expects Colt about half the time.

`answerFocus` (in `simulation`) is a guess until it can be fitted from real picks. Lower values
(enemies mostly pick what's popular) make first and last picks *more* alike, because the counter
risk averages out; 100 keeps it about where it was before the meta weighting.

| Part | What it measures |
|---|---|
| `map` | Strength on this map, with matchup and team luck removed (see below) |
| `counter` | Matchups against the enemies already picked (summed) |
| `synergy` | Pairs with the allies already picked (summed, × `synergyWeight`) |
| `later` | Matchups against the enemy's likely picks (a spread that follows the meta, see above) and pairs with your likely teammates, from playing out the rest of the draft (0 at the last pick) |
| `role` | Fills a role your team lacks, duplicates one it has, or answers an enemy role (`roles`, × `roleWeight`) |
| `comfort` | How much better you do on it than everyone else, from your own ranked games (× `comfortWeight`) |
| `unproven` | A cost for having few games on this map: the less evidence, the bigger it is |

**Smoothing.** Win rates are smoothed with `(wins + k × prior) / (games + k)`. A map rate's prior
is the brawler's rate on the mode's *other* maps; that one's prior is its rate in *other* modes;
then 50%. Using only outside games means no game counts twice. `k` values are in `smoothing`.

**Carry-over.** Only part of a brawler's edge elsewhere carries over to this map (`carryover`):
a close-range brawler that wins on Safe Zone can lose on Bridge Too Far, and rarely picked
brawlers' win rates are inflated by specialists.

**Matchups and pairs** are measured against expectation (a strong brawler beats most enemies, so a
matchup only counts as a counter if it beats what the two brawlers' own win rates predict), per
mode, with only the effect carrying over between modes. They're shrunk by **empirical Bayes**: from
all pairs in the data the engine fits how much real effects vary (about ±2.2 points) and how noisy
one game is, then shrinks each pair toward 0 by exactly as much as its sample size calls for.
Real data's pair effects are bell-shaped (checked: kurtosis ~3.0), which is what this assumes.

**Luck.** A brawler's win rate includes the matchups and teammates it happened to get. Brawlers
picked when it's safe (late, into no counters) enjoy good matchups; popular blind picks get
countered. `map` uses strength with that luck removed, so matchups are only counted once: from
the actual board, or from the predicted rest of the draft. For each enemy pick still to come,
`later` counts whichever is worse for you: your expected matchup against the enemy's likely picks,
or the matchup the brawler really gets per enemy in its games (real players counter popular blind
picks harder than the simulation).

**Output** (`Recommendation` in `src/engine/types.ts`) is plain JSON: the draft context, data
freshness, the map's most-picked brawlers (`data.mapMeta`), and the top `handOffTop` candidates,
each with its score, the parts, up to three reason tags, a warning (rarely picked here, or likely
enemy answers that clearly beat it), the build, the enemy's likeliest picks (with the chance of
each) and your likely teammates, how it does against the map's meta (`intoMeta`), and the details
behind each part. The UI shows the first `showTop`; the AI layer gets all of them.

**Draft order** is in `config/draft.json`: which team makes each of the six picks.

### Trying it from the terminal

```bash
git clone -q --depth 1 --branch data https://github.com/aldencressy/brawl-draft-coach.git data
npm run suggest                                   # lists current ranked maps
npm run suggest -- --map "hard rock" --slot 6 --ally gene,emz --enemy mortis,crow,bull --ban colt,spike
```

Add `--json` to see the full output, or `--link` to also print a link that opens the coach with
this draft filled in (map, your slot, bans and picks; `COACH_URL` changes the site). The link
looks like `…/brawl-draft-coach/#map=15000367&slot=4&bans=16000043&allies=16000001&enemies=16000003,16000031`
(brawler and map ids). Opening it starts a fresh draft with those entries, then clears them from the
address bar so a refresh keeps your edits. To refresh the data later: `rm -rf data` and clone again.

Checks worth running after changing weights:

```bash
npm run suggest -- --all --slot 1                     # top 5 on every current map; * marks thin data
npm run suggest -- --calibration --map "bridge too far"  # average edges; should all be near 0
npm run backtest                                      # how well it predicts real results (below)
```

### Backtest

`npm run backtest` checks the engine against real results. For each day with a game sample
(`games/<date>.json`), it builds the stats from the days *before* it, so the engine has never seen
the games it predicts, then scores every sampled game the way the engine scores a 3v3: map
strength, matchups against the other team and teammate pairs. It reports:

- how often the favored team won, and the log loss (lower is better; a coin flip is 0.693)
- variants (counters ×0.5 or ×1.5, pairs ×0.5 or ×2, no counters, map strength with luck left
  in) and whether each predicts clearly better or worse than the engine
- the best-fitting weight for map strength, counters and pairs (1 = the engine's weight now)

Run it after changing `weights.json` or the model, and keep a change only if it predicts better.
`--day 2026-11-07` tests one day. It reads `DATA_DIR` like `suggest` does.

What it has found so far (Nov 6 and 7, 40,000 games each): the engine picks the winner about 58%
of the time from the draft alone. Map strength and counters are weighted right (best fits about
1.0 and 1.1–1.2); counting counters half or 1.5× as much predicts worse. Teammate pairs were
counted about twice as much as they deserve, hence `synergyWeight: 0.5`. Removing matchup luck
from map strength predicts better than leaving it in. Matchups per map (instead of per mode) were
also tested, from 160,000 sampled games: maps of the same mode differ from the mode-wide matchup
by no more than chance, and predictions didn't change on any of four days, so matchups stay per
mode. Role fit and your own record aren't in the
backtest, since game results can't measure them.

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
| `sampleGamesPerDay` | `40000` | Games per day kept whole in `games/<date>.json` (0 = none): about 4 MB a day (under 1 MB compressed) |
| `recencyDecay` | `0.85` | In `stats.json`, each day counts this much relative to the next one (1 = all equal) |
| `balanceChange` | `{"date": null, "weightBefore": 0}` | After a balance patch that changes many brawlers, set `date` to the day it went live; days before it count `weightBefore` (0 = dropped) |
| `brawlerChanges` | `[]` | After a change to one or a few brawlers (a buff, a nerf, new Buffies): only their older games are discounted (see below) |

### After a balance change

Set the date in `config/collector.json` and push:

```json
"balanceChange": { "date": "2026-11-12", "weightBefore": 0 }
```

The next hourly run rebuilds `stats.json` from that day on; the page header then reads
"… games since the Nov 12 balance change". `weightBefore: 0.3` keeps older days at 30% instead,
which helps for the first day or two when post-patch data is thin. Set `date` back to `null`
once the window has moved past it. The raw daily totals on the `data` branch are never changed,
so either setting can be undone.

When only a few brawlers change (a single buff or nerf, a brawler's new Buffies), discount just
their games instead, and keep everyone else's:

```json
"brawlerChanges": [
  { "brawler": "Mr. P", "date": "2026-11-05", "weightBefore": 0 }
]
```

That brawler's games before `date`, and its matchups and pairs, count `weightBefore` as much
(default 0). Names are matched loosely ("mr p" works); an unknown name is reported in the run log
and skipped. Its pick rate is measured against the games it could have been in, so it doesn't
look rarely picked while its older games are discounted.

## Development

```bash
npm test          # unit tests
npm run typecheck
```


