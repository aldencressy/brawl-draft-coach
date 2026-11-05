# Brawl Draft Coach

Live drafting coach for Brawl Stars ranked. A collector gathers ranked match stats on a schedule;
a static page suggests your best pick as you tap in the draft.

Status: **Milestone 1** (API client, key check, inspect script, mock server).

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

## Without a key: mock server

```bash
npm run mock
```

Then, in another terminal:

```bash
BS_API_BASE=http://localhost:8787/v1 BS_API_KEY=mock MY_TAG=9LQ0P npm run verify-key
```

`MOCK_FLAKY=1 npm run mock` makes every third request fail, to exercise retries.
Fixture data in `fixtures/` is synthetic; see `fixtures/README.md`.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `BS_API_KEY` | — | Your API key |
| `BS_API_BASE` | `https://bsproxy.royaleapi.dev/v1` | API base URL (proxy, or the mock) |
| `MY_TAG` | — | Your player tag, for the roster |
| `BS_RATE_LIMIT_RPS` | `8` | Max requests per second |

## Development

```bash
npm test          # unit tests
npm run typecheck
```

GitHub secrets, the `data` branch and Pages setup are added in later milestones.
