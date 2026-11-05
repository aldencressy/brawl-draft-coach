# Fixtures

Synthetic API responses served by the mock server (`npm run mock`). They follow our best
understanding of the official API's shapes, not confirmed real data.

- `players/9LQ0P.json` is the mock "my profile" (use `MY_TAG=#9LQ0P` against the mock).
- `battlelogs/*.json` contain 30 shared ranked matches (each one appears in up to 6 logs, so dedupe
  has something to do), plus trophy-mode and showdown battles the ranked filter should skip.
- The assumed ranked draft battle type is `soloRanked`. `npm run inspect` against the real API will
  confirm or correct this; replace these files with real samples once we have them.
