# Nifty Sector Dashboard

A FastAPI backend + vanilla JS frontend for tracking NSE's F&O (futures &
options) universe: sector heatmap, breadth, movers, and several self-tracked
intraday scanners. Two frontends ship from the same API — `/` (light,
original build) and `/pro` (dark, restyled pass) — for side-by-side
comparison.

## Features

- **Sectoral heatmap** — all 23 NSE sectoral indices as color-coded tiles,
  unfiltered, matching NSE's own site tile-for-tile. Click a tile for every
  constituent stock's LTP, change %, open, and volume (with a TradingView
  chart link on every symbol).
- **Market Bias** — a same-session breadth reading (Nifty 50, India VIX,
  advance/decline, F&O and sector breadth) — explicitly *not* a prediction,
  and doesn't include Sensex or global indices (no reliable free source for
  either was found).
- **Nifty 50 Advance vs Decline vs today's open** — vs *open*, not previous
  close (NSE's own advance/decline counters use previous close).
- **F&O Gainers / Losers**, **Most Active Equities**, **Volume Gainers**,
  **52-Week High/Low** — all filtered to the F&O universe, all sortable.
- **F&O Stock List (Volume & RSI)** — a liquidity/valuation screener (market
  cap, cap-to-turnover ratio, turnover, run-up from 52w low), RSI(14) shown
  for reference. One condition from the source screener (ROCE vs its 3-year
  average) is intentionally not applied — no accessible data source for
  financial-statement ratios.
All of the below live together in one tabbed "Scanners" panel (Opening
Range Breakout / Buy-Sell / 15-Min Breakout / Screener) so only one is
rendered at a time — this keeps the page short on a phone instead of
stacking four full sections:

- **Opening Range Breakout (ORB) Scanner** — 5/15/30/45/60-min windows,
  self-tracked (see below).
- **Buy/Sell Scanner (Bullish/Bearish Intraday)** — daily (SMA20/RSI14/5-day
  range, from real EOD history) + a selectable intraday timeframe (self-
  tracked), a stock only "qualifies" once both agree.
- **15-Min Breakout Scanner** — an independent, pure 15-min scanner (close
  vs rolling 20-bar close-high, volume vs its own 20-bar SMA), replicated
  from two published screeners.
- **F&O Screener** — 5 independent daily-technical screens (Bullish Trend
  MA+ADX+MACD, Open=High/Low, Strong Uptrend, Volume Shockers, a price-range
  scan), each replicated from a published Chartink scanner, all real (no
  self-tracking - runs on ~65 real trading days of Bhavcopy history). A
  second batch of published screens needing weekly/monthly bars and a
  Camarilla pivot isn't built yet.

## Running it

```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8420
```

Then open http://localhost:8420 (classic) or http://localhost:8420/pro (dark).

The page auto-refreshes every 20 seconds while the tab is open.

## How it talks to NSE

NSE doesn't publish a public API — `backend/nse_client.py` calls the same
undocumented endpoints nseindia.com's own pages use, plus its daily
"Bhavcopy" (EOD settlement) archive, which turned out to be real, working,
and *not* behind the same bot-protection as the JSON APIs:

- `/api/allIndices`, `/api/equity-stock-indices` — live index/stock snapshots
- `/api/live-analysis-variations`, `-volume-gainers`, `-most-active-securities`,
  `-data-52weekhighstock/-lowstock` — movers lists
- `/api/master-quote` — the current F&O-eligible symbol list
- `archives.nseindia.com/.../sec_bhavdata_full_DDMMYYYY.csv` — real daily OHLC
  history (SMA/RSI/range conditions), ~30 trading days fetched and cached

A `requests.Session()` first hits a normal nseindia.com page to pick up
cookies, then reuses that session for API calls, re-bootstrapping on
401/403. Responses are cached briefly in-process.

**No reliable source exists for true intraday candles** (NSE's own
chart endpoint returns empty; the per-symbol quote endpoint is hard-blocked;
historical intraday endpoints error out) — so the ORB/Buy-Sell/Breakout
scanners **self-track**: a background thread polls the F&O universe every
~20s during market hours (09:15–15:30 IST, Mon–Fri) and buckets those
samples into candles itself. Completed intraday candles are persisted to
`backend/intraday_history_{15,30,45,60}m.json` so history survives restarts
and accumulates across trading days — a 20-period SMA/RSI needs ~20 bars,
which 15-min bars reach within one session, but 30/45/60-min need several
days of the process actually having run.

**Caveat:** none of this is an official, versioned API — NSE can change
endpoint shapes without notice. An error banner in the UI is the signal to
check `backend/nse_client.py` against what NSE's own network tab shows.

## Deploying it somewhere you can reach from your phone

This app is **not a static site or a simple stateless API** — the
self-tracking background thread above needs to run continuously through
market hours, and its persisted JSON files need to survive restarts. That
rules out:
- Free-tier PaaS instances that spin down when idle (kills the tracking
  thread silently — the UI still loads, but scanners never accumulate data)
- Ephemeral-filesystem hosts without a persistent volume/disk option

**A `render.yaml` is included** for [Render.com](https://render.com) - use
its **paid Starter plan** (not Free, for the reason above) with the attached
persistent disk, which the config already wires up via `NIFTY_DATA_DIR`. Push
this repo, connect it on Render as a Blueprint, and it deploys as-is.

A small always-on VPS (DigitalOcean/Hetzner/Linode, ~$5-6/mo) works just as
well if you'd rather run it yourself - `uvicorn backend.main:app --host 0.0.0.0
--port 8000` behind Nginx + a systemd service, with `NIFTY_DATA_DIR` pointed
at a persistent path.

Either way, this app can't run inside typical page-builder hosting
(WordPress, Wix, Squarespace, Shopify, etc.) since those don't execute a
Python backend — deploy it separately and link to it (or point a subdomain
like `nifty.yoursite.com` at it via a CNAME).
