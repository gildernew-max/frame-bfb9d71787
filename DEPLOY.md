# Frame TV dashboard: deploy and run

Permanent hosting is **GitHub Pages** on the `gildernew-max` account, in the public repo
`gildernew-max/frame-bfb9d71787`. The repo name is random on purpose, so the URL is hard to guess.
Free Pages needs a public repo. The repo holds no secrets: the Finnhub key lives only in
GitHub Actions secrets.

- Site: https://gildernew-max.github.io/frame-bfb9d71787/
- Data: https://gildernew-max.github.io/frame-bfb9d71787/data.json

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Page | `docs/index.html` | The locked v6 design. It polls `data.json` every 3 minutes and renders it. The clock, spotlight rotation and headline rotation run in the browser. No keys. |
| Fetcher | `scripts/fetcher.mjs` | Pure Node (18+), no dependencies. Builds the next `data.json` from the previous one. A failed source keeps its last good data plus `lastError`/`lastAttempt`, so the page can show "as of … · stale". |
| CLI | `scripts/update.mjs` | `node scripts/update.mjs [--force] --out docs/data.json`. Reads the old file, runs whatever is due, and writes it back. |
| Schedule | `.github/workflows/update-data.yml` | Cron, then commit `docs/data.json` to `main`, then deploy `docs/` to Pages. |
| Local preview | `scripts/server.mjs` | Serves `docs/` plus `.local/data.json` on PORT (default 8787), using the same fetcher on a 5-minute loop. |

### What the fetcher decides on each run (America/New_York clock)

- **Stocks (Finnhub `/quote`).** Fetched every 15 minutes while `stock/market-status` says the US market is open (weekdays 9:30 a.m.–4:00 p.m.; holidays come from Finnhub). There is one close fetch at 4:04 p.m. ET or later on trading days. Otherwise the page shows the last close ("Markets closed · opens Mon 9:30" and "Friday close"). Symbols: NVDA, TSLA, SPCX and ANT. For the indexes it tries ^DJI, ^GSPC and ^IXIC first. Finnhub's free plan rejects those ("Market data subscription required"), so it falls back to **DIA, SPY and QQQ**, labeled "Dow Jones fund", "S&P 500 fund" and "Nasdaq fund". ANT stays "Upcoming · IPO Nov 19 · $70–78 range" until Finnhub returns a real quote on or after 2026-11-19. Sparklines come from the quote history the fetcher keeps (`stocks.history`, last 80 points). Until a symbol has 2 or more points, its chart runs from the prior close to the last price.
- **Weather.** Open-Meteo for Atlanta (main) and Saint Paul: current conditions, a 3-day forecast, and sunrise/sunset. Fetched once a day after 6:00 a.m. ET, retried hourly on failure. The fallback is NWS api.weather.gov, with sunrise/sunset computed locally. Credit shown: "Weather: Open-Meteo".
- **NFL.** ESPN public JSON (standings, team schedule and team pages) for PIT, MIN and GB: record, division rank, streak and next game. Fetched once a day after 6:00 a.m. ET.
- **Headlines.** BBC News business RSS and NPR Business (1006) RSS, fetched hourly. Duplicates are dropped and the 5 newest kept, headline and source only. If one feed fails, the other is used.

## One-time setup (already done on 2026-11-15)

```bash
gh repo create gildernew-max/frame-bfb9d71787 --public --source . --push
gh secret set FINNHUB_KEY --repo gildernew-max/frame-bfb9d71787 < /workspace/frame-dashboard/.secrets/finnhub_key.txt
gh api -X POST repos/gildernew-max/frame-bfb9d71787/pages -f build_type=workflow
gh workflow run update-data.yml --repo gildernew-max/frame-bfb9d71787 -f force=true
```

## Routine operations

- **Rotate the Finnhub key:** `gh secret set FINNHUB_KEY --repo gildernew-max/frame-bfb9d71787 < keyfile`. Never paste the key into the HTML, the repo, or chat.
- **Force a full refresh:** `gh workflow run update-data.yml --repo gildernew-max/frame-bfb9d71787 -f force=true`.
- **Check runs:** `gh run list --repo gildernew-max/frame-bfb9d71787 --workflow update-data.yml`.
- **Change the page:** edit `docs/index.html` and push to `main`. The push triggers a run and a Pages deploy.
- GitHub cron can run several minutes late at busy times. GitHub also pauses scheduled workflows in a repo with no activity for 60 days. The data commits count as activity, but if runs ever stop, re-enable the workflow in the Actions tab.

## Local preview (box or Raspberry Pi)

```bash
FINNHUB_KEY_FILE=/path/to/finnhub_key.txt PORT=8787 nohup node scripts/server.mjs > server.log 2>&1 &
node shot.cjs http://localhost:8787/ preview.png   # 3840x2160 screenshot (playwright)
```

A no-account public preview can come from a Cloudflare quick tunnel:
`cloudflared tunnel --url http://localhost:8787`. The trycloudflare URL changes every time the
process restarts. On the Kalesi box, outbound port 7844 (cloudflared) and outbound SSH tunnels
(localhost.run, pinggy) are blocked, so use the Pages URL from the box. On the home network
or the Pi, the quick tunnel should work.

## Optional: Cloudflare Workers instead of Pages

Not used. Dave chose GitHub Pages. If it is ever wanted: wrap `runFetch()` in a Worker
`scheduled()` handler that reads and writes KV, plus a `fetch()` handler that serves the page and `/data.json`.
Then `wrangler login`, `wrangler kv namespace create FRAME`, `wrangler secret put FINNHUB_KEY`, and `wrangler deploy`.
