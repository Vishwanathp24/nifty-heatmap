# NSE F&O Stock Dashboard — Full Rebuild Specification

Paste this into a fresh Claude Code (or any capable coding agent) session to
rebuild this exact tool from scratch, in a different location, on a
different machine. It's self-contained: tech stack, exact file layout,
every page/scanner's precise rule, the design system, deployment config,
and the non-obvious gotchas that cost real debugging time the first time
around.

This is a **from-scratch build spec**, not a chronological history. If you
also want the messy story of how this was built (features tried and
reverted, bugs found and fixed, decisions made along the way), see
`PROJECT_CONTEXT.md` in the original repo — that's a dev log, this is a
clean reference.

---

## 1. What this is

A single-page dashboard tracking NSE's F&O (futures & options) universe
(~208-210 stocks) in real time: sector heatmap, market breadth, movers,
10 self-built technical scanners, a full-universe searchable/sortable
stock table, Swing Trading screens, and IPO tracking. Dark-themed,
sidebar-nav layout. No user accounts, no database in the traditional
sense — it's a single-tenant tool for one user's own trading research.

**Not investment advice** — every scanner/screener in this app is framed
as "technical research," never a buy/sell recommendation, and that framing
should be preserved throughout (see section 8).

## 2. Tech stack

- **Backend**: Python 3, FastAPI, plain `uvicorn` (no Gunicorn/workers -
  single process, relies on one shared in-memory state + background
  threads — see section 4 for why this matters).
- **Frontend**: zero-build vanilla HTML/CSS/JS. No React/Vue/npm/webpack/
  Vite — three flat files (`index.html`, `app.js`, `styles.css`), loaded
  directly by the browser. Every backend API call goes through one
  `fetchJSON(url)` helper, always a relative `/api/...` path (same-origin).
- **Data sources**: NSE's own undocumented public JSON endpoints (the same
  ones nseindia.com's website itself uses), NSE's daily Bhavcopy CSV
  archive (EOD settlement data, a *different*, non-bot-protected endpoint),
  screener.in's public IPO pages (scraped), Yahoo Finance (for global
  indices/Sensex), and Fyers' broker API (optional, real-time quotes for
  one specific table).
- **Deployment**: Render.com, `type: web`, **paid tier required** (not
  free) — explained in section 4.
- **Dependencies** (`requirements.txt`):
  ```
  fastapi>=0.110
  uvicorn[standard]>=0.29
  requests>=2.31
  fyers-apiv3>=3.1.3
  python-dotenv>=1.0
  ```

## 3. Repo structure

```
backend/
  main.py              — FastAPI app, ~40 routes, thin wrappers around client methods
  nse_client.py         — ~3500 lines, ALL scanner/screener logic + NSE data fetching
  screener_client.py    — screener.in IPO scraper (separate site, separate client)
  global_markets_client.py — Yahoo Finance (Sensex, global cues)
  fyers_client.py       — Fyers broker OAuth + quotes (optional real-time layer)
frontend_pro/
  index.html            — all page markup (one <section data-view="..."> per sidebar page)
  app.js                 — all client logic (~2600+ lines, no framework)
  styles.css             — design system + component styles
render.yaml              — Render.com deploy config
requirements.txt
.env                     — local-only secrets (Fyers app credentials), never committed
```

No `frontend/` (classic/light-theme) directory exists any more — this dark
sidebar-nav build (originally called `/pro`) is now the *only* frontend,
served at `/`.

## 4. Why the backend is stateful (read this before "simplifying" anything)

**NSE has no public API for historical intraday candles or previous-day
OHLC** — every such endpoint that looks promising either 403s or returns
empty. So the backend runs **two background threads**, started the moment
the Python process boots (module-level singletons — `client = NSEClient()`
at the bottom of `nse_client.py`, `client = ScreenerClient()` at the bottom
of `screener_client.py`):

1. **`orb-tracker`** — `while True: tick(); sleep(20)`, gated to do real
   work only 09:15–15:30 IST weekdays. Polls live quotes for the whole F&O
   universe every ~20s and:
   - Captures Opening-Range-Breakout high/low at 5/15/30/45/60-min windows
     after market open.
   - Appends `(timestamp, price, cumulative_volume)` tuples to an
     in-memory tick buffer, reset daily.
   - Buckets those ticks into OHLCV candles at 5/15/30/45/60-min sizes,
     persisting completed candles to disk (survives restarts, accumulates
     across trading days — this is the *entire* source of every
     intraday-timeframe scanner condition in the app).
   - Tracks "first qualified" timestamps per scanner (in-memory only).
2. **`long-daily-history`** — every 6 hours, walks NSE's Bhavcopy archive
   to build/extend a ~260-trading-day daily OHLC series per F&O symbol,
   persisted as one JSON file (grows to tens of MB). This is what powers
   every scanner needing real multi-day history (RSI, SMA stacks, 52-week
   highs, DMA, etc.) — there's no synchronous/on-demand rebuild path, it's
   purely background-built.
3. **`ScreenerClient`**'s own thread refreshes screener.in's Recent IPOs
   list every 3 hours (in-memory only, no disk persistence).

**Consequence**: this cannot run on a free-tier PaaS that spins down when
idle, or on any serverless/Functions platform (Netlify Functions, AWS
Lambda, etc.) without a substantial redesign — a serverless invocation
exits between requests and takes its background thread with it. It needs
an **always-on process** (Render's paid "Starter" plan + a persistent disk
for `NIFTY_DATA_DIR`, or an equivalent small VPS).

**NSE session handling**: one shared `requests.Session()` per client
instance, reused across all requests. A "bootstrap" GET to a specific NSE
page is needed first to get past Akamai bot-protection before the JSON
APIs respond; bootstrap is cached for 240s and retried once on
401/403/5xx. The Bhavcopy CSV archive is a *separate* endpoint that does
NOT need this bootstrap dance.

## 5. Design system

**Font**: no custom/downloaded font — a native system-font stack, so it
renders in the OS's own UI font with zero network cost:
```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

**Colors**: defined as CSS custom properties in OKLCH color space (not
hex), with a `[data-theme="light"]` override block for light mode (dark is
default). Hex equivalents for reference:

| Token | Use | Hex (dark) | Hex (light) |
|---|---|---|---|
| `--bg` | page background | `#080D18` | `#F3F5F9` |
| `--panel` | card background | `#111826` | `#FFFFFF` |
| `--panel-alt` | alt panel/hover | `#192030` | `#EFF2F7` |
| `--border` | borders | `#262E3D` | `#DEE1E8` |
| `--ink` | primary text | `#E7EBF4` | `#12161F` |
| `--muted` | secondary text | `#9298A5` | `#585E69` |
| `--purple` | **brand accent** (active tabs, links) | `#9174F9` | same |
| `--purple-dark` | accent hover/pressed | `#7454D6` | same |
| `--up` | gains/bullish | `#20C45F` | same |
| `--up-bg` | positive badge tint | `#20C45F` @ 12% alpha | same |
| `--down` | losses/bearish | `#F94144` | same |
| `--down-bg` | negative badge tint | `#F94144` @ 12% alpha | same |
| `--amber` | warnings/neutral | `#F5A400` | same |

Rounded corners (`--radius: 12px`, `--radius-sm: 8px`), soft shadows, no
hard borders on cards — a modern, muted dark-mode-first fintech look.

**Layout components** to replicate:
- **Sidebar nav** (`.sidebar`/`.nav-item`) — fixed-width, icon + label
  buttons, one active at a time, drives a client-side view router (each
  page is a `<section class="view" data-view="X">`, toggled via
  `.active`/`.hidden` classes — no real routing/URL changes).
- **Folder tabs** (`.folder-tabs`/`.folder-tab`) — pill-style sub-tab bars
  used *within* a page (e.g. Scanners' 10 sub-tabs, Scanner Links' 4
  source tabs, nested strategy tabs inside Chartink). Active tab = solid
  `--purple` pill; inactive = dark `--panel-alt` pill.
- **Quick-filter chips** (`.qf-chips`/`.qf-chip`) — same visual pill style
  as folder-tabs but for in-panel mode/period selectors (e.g. Breakout
  Scanner's 10/20/50/100/200-day/52-week period chips).
- **Data tables** (`renderMoversTable` in app.js) — a single generic
  sortable + paginated (10 rows/page) table renderer reused by every
  scanner/screener page: pass it a `columns` array (`{header, render,
  sortKey?, cls?}`) and a `rows` array, it handles sort-on-click,
  pagination, and empty states.
- **Cards** (`.card`, `.card-head`) — the base panel container everywhere.

## 6. Full page inventory (sidebar, top to bottom)

1. **Dashboard** — landing page. Market Bias card (Bullish/Bearish/Neutral
   label only, no numeric score), Global Cues (GIFT Nifty + overnight
   US/Asian markets), Sensex, top gainers/losers/high-volume mini-lists,
   FII/DII flows, PCR (Put-Call Ratio).
2. **Sector Heatmap** — all 23 NSE sectoral indices (deliberately NOT
   deduped/consolidated — mirrors NSE's own site tile-for-tile). Click a
   tile → drawer with constituent stocks + TradingView chart links.
3. **F&O Scanner** — the full F&O universe (~208 symbols) in one
   searchable/sortable/paginated table: quick-filter chips (All/Breakout/
   Price Up/Price Down/High Volume/52W High/52W Low), a filter row
   (Sector/Market Cap band/Price range) with Apply/Reset, 5 summary cards,
   a Columns show/hide dropdown, CSV export (client-side Blob download).
   Below the table: Top Gainers/Losers/High Volume mini-lists + a compact
   Sectors Heatmap grid.
4. **F&O Gainers & Losers** — reuses the same live gainers/losers data as
   its own dedicated page.
5. **Scanners** — 10 folder-tabs, each a self-contained scanner (exact
   rules in section 7).
6. **Scanner Links** — NOT a scanner itself; a curated list of external
   links to the Chartink/Downstox/screener.in screeners this app's own
   scanners were modeled after, plus generic "build your own scan" tool
   links. 4 top-level tabs:
   - **Chartink** (24 links) — further split into 4 strategy sub-tabs:
     F&O Stocks, Intraday, Swing Trading, BTST (grouped by a best-effort
     read of each screener's own name, since Chartink exposes no category
     field).
   - **Downstox** (3 links) — Breakouts, Signals, Scanner (their own
     pages — this app has *native* equivalents of the first two, see
     Scanners tab items 9-10).
   - **Screener.in** (1 link) — their own screen-builder tool.
   - **Other** (1 link) — a Telegram channel that doesn't fit the above.
   No panel repeats its own tab name as a heading (redundant, removed).
7. **Market Breadth** — Nifty 50 advance/decline vs today's open (not
   previous close), a sectors-heatmap mini-panel, sector filter, and the
   full 50-stock table **shown expanded by default** (not behind a
   "Show all" toggle — that was a real usability bug: the table looked
   empty until a barely-visible toggle was clicked).
8. **Market Movers** — 3 sub-tabs: Top Movers (Most Active by Volume/
   Value, Near Day High/Low), 52W High/Low, Volume Shockers.
9. **Swing Trading** — 3 sub-tabs: Stocks (NIFTY 500 universe — DMA
   5/20/50/100/200 + 52-week high/low + a selection score), ETFs (all
   NSE ETFs, 20-DMA + volume), International ETFs.
10. **IPO (Initial Public Offering)** — 2 sub-tabs: Upcoming IPOs
    (currently open for subscription), Recent IPOs (listed in the last 3
    years, searchable, sorted newest-first by Listing Date by default —
    search/sort/page state all reset when switching sub-tabs).
11. **Watchlist** — stub (not built; needs new persistence).
12. **Settings** — stub (not built; needs new config UI).

Every page's header shows: page title, a live "Market Open"/"Market
Closed" pill, current time, a manual refresh button, a light/dark theme
toggle (persisted via `localStorage`), and an Auto Refresh switch.

## 7. Every scanner's exact rule (Scanners tab, 10 sub-tabs)

All scanners below are scoped to the **F&O universe** unless noted, and
each exposes a paired `/status` endpoint (`ready: bool`, bars-available/
needed counts) so the frontend can show "building..." instead of an empty
table while background history warms up. **Preserve every rule exactly,
including asymmetric/quirky ones** — these were deliberately copied from
specific published Chartink screeners; "fixing" an asymmetry is a bug, not
an improvement.

1. **Opening Range Breakout (ORB)** — self-tracked, 5/15/30/45/60-min
   windows. Only shows stocks whose price has actually broken outside
   that window's captured high/low range.
2. **Buy / Sell (Bullish / Bearish)** — daily (real, Bhavcopy-backed) AND
   1-hour (self-tracked) legs, each: Close vs SMA(20) · Close vs each of
   the last 5 bars' High (bullish) or Low (bearish) · RSI(14) > 60
   (bullish) or < 40 (bearish). A stock only fully "qualifies" once BOTH
   legs pass; the table lists every stock passing the daily leg alone,
   with a Status column showing "Qualified" vs "Daily only" (an earlier
   qualifies-only filter was reverted — showing daily-pass candidates,
   honestly labeled, beat an often-empty fully-qualified-only table).
   Fixed 60-min timeframe (a 15/30/45/60-min selector chip existed, was
   removed for simplicity).
3. **15-Min Breakout** — pure 15-min, independent of the above: Close vs
   its own rolling 20-bar Close-high (bullish) or Close-low (bearish),
   Volume vs its own 20-bar SMA. **The Sell/bearish variant deliberately
   wants volume BELOW average** (not a spike) — the source scanner's own
   asymmetric rule, kept as-is on purpose.
4. **Downtrend Scanner** — daily-only (an Intraday mode existed, removed):
   EMA(20) < EMA(50) < EMA(200) downtrend stack, RSI(14) < 45, ADX(14) >
   20, volume above its own 20-period average.
5. **Bullish Scanner** — (labeled "Bullish Intraday Scanner" in Scanner
   Links, since it names the actual external screener) daily + 1-hour,
   each: Close vs SMA(20) · Close vs each of the last 5 bars' High ·
   RSI(14) > 60. Byte-for-byte the same rule as the Buy/Sell scanner's
   bullish leg — kept as a separate named tab because it maps 1:1 to a
   specific published screener the user maintains.
6. **Bearish Scanner** — mirror of the above, Low/RSI<40.
7. **Bullish Morning Scanner** — ALL 16 conditions required: today's
   daily range (High−Low) beats each of the last 7 days' own range ·
   green candle (Close > Open, Close > yesterday's Close) · this week's
   and this month's Close above their own Open · yesterday's volume >
   10,000 · SMA(20) > SMA(40) > SMA(60) of Close · today's volume > 1.25×
   yesterday's · latest 15-min candle's Close > its own Open. **"ROCE <
   30" and "EPS > 0" from the original spec are explicitly NOT
   evaluated** — no fundamentals/financial-ratio data source exists in
   this app; say so plainly in the UI rather than faking it. Shows every
   stock passing the 15 daily/weekly/monthly conditions, with a Status
   column for the 16th (intraday) condition.
8. **BTST Scanner** (Buy Today, Sell Tomorrow) — daily-only, ALL 5
   required: today's volume > 3× its own 5-day average · RSI(14) > 65 ·
   today's Open AND Close both above yesterday's · today's Close within
   15% of its own 250-day high. No intraday leg (ready immediately, no
   warm-up needed). Scoped to F&O universe by explicit choice, though the
   source screener runs on the full ~2000-stock cash segment.
9. **Breakout Scanner** (originally "Breakout Highs Scanner") — a native
   equivalent of a third-party site's "Breakouts" page, NOT scraped
   (their robots.txt explicitly disallows AI crawlers — see section 9).
   Computed directly from this app's own daily history: a stock "breaks
   out" at period N if today's daily High exceeds the highest daily High
   of the preceding N trading days. Six periods, each its own full list
   (not deduplicated to "best tier only"): 10/20/50/100/200-day and
   52-week (252 trading days) — shown as period-selector chips within the
   tab, computed once per fetch (all 6 periods in one backend response),
   switching chips just re-renders client-side with no extra request.
10. **F&O Screener** (originally "F&O Signal Screener") — a deliberately
    *reduced* native equivalent of a third-party multi-factor confluence
    screener. The real thing scores 5 readings including Open Interest;
    **this app has no OI data source**, so by explicit choice it scores
    only 4, as a 0-4 confluence count:
    1. VWAP position — today's LTP vs its own volume-weighted average
       price (computed from this app's self-tracked 5-min candles).
    2. Momentum — % change over the last 3 completed 5-min candles
       (deliberately distinct from the day's overall %Chg).
    3. Relative volume — today's cumulative volume vs its own 5-day
       average, only counted once it clears 1.5×, and even then it only
       ever *confirms* whichever direction the day's %Chg already points
       (volume alone has no direction).
    4. Day-range position — where LTP sits between today's Low and High,
       only counted past 70% (near the high) or below 30% (near the low).
    Score = however many of the 4 agree on one side; signal is
    `BULL {score}/4`, `BEAR {score}/4`, or `MIXED` on a tie (0/4
    included). This is inherently NOT ready for the first few minutes
    after each day's market open (readings are purely intraday, not
    multi-day history) — every day, regardless of app uptime.

Also outside the Scanners tab: **F&O Stock List** (Volume & RSI
liquidity/valuation screener — Market Cap > ₹30,000 Cr, Market Cap/
Turnover ratio < 3000, Turnover > ₹50 Cr, Up-from-52-week-low < 200%; one
condition, ROCE vs 3-year average, intentionally not applied — no
accessible data source), and **Swing Trading**'s selection scoring
(Consolidating/Avoid label based on price sitting within ±5% of every one
of 5 DMAs; a Base-Over-High eligibility flag; a DMA Breakout Score 0-5;
sorted by the combined score).

## 8. Framing & tone (non-negotiable)

Every scanner/screener page includes an explicit disclaimer that this is
**technical/analytical research, not investment advice** — no buy/sell
calls, not SEBI-registered. Any scanner with a known gap versus its
source (missing fundamentals data, reduced confluence factors, smaller
universe than the original) states that gap plainly in its own
description text rather than silently approximating it.

## 9. Data-source integrity rule

When building a "native equivalent" of a third-party site's tool (as with
the Breakout/F&O Screener above), **check that site's `robots.txt` before
ever scraping it** — if it names AI-associated crawlers in a `Disallow`
rule separate from its general policy, treat that as the site owner
declining automated collection, and build a native equivalent from this
app's own data instead of working around the block. This came up for real
during development (a site's robots.txt explicitly disallowed
Claude-associated crawlers) and the decision was to respect it.

## 10. Known gotchas (save yourself the rediscovery time)

- **`_TTLCache`/empty-result poisoning**: a plain "cache this for N hours"
  wrapper doesn't distinguish "genuinely fresh data" from "cached a
  failed/empty build result." If an external fetch (Bhavcopy archive)
  transiently fails and returns empty, a naive TTL cache will serve that
  empty result for the FULL TTL even after the source recovers. Fix:
  check-and-retry-immediately-on-empty rather than trusting a stale
  cache blindly, for any cache backing a scanner.
- **Pagination "empty page = end of list" is not always true** — a
  paginated scrape (screener.in's IPO pages) can, past the site's real
  last page, keep re-serving the SAME page's rows for every later page
  number requested, instead of returning empty. Dedupe by a stable key
  while walking, and stop as soon as a page brings nothing new — don't
  rely solely on "empty page" as the stop condition.
- **CSS Grid `1fr` overflow**: bare `1fr` grid tracks don't clamp below
  their content's min-content width; use `minmax(0, 1fr)` (+ `min-width:
  0` on nested grid items) for any side-by-side panel layout.
- **Browser caching**: FastAPI's default static/file responses don't set
  `Cache-Control`; add a global no-cache middleware, and if a frontend
  edit seems to not take effect, check for a duplicate stale uvicorn
  process before assuming the edit failed.
- **RSI** is a simplified trailing-window average (not full Wilder
  smoothing from inception) — a documented, standard simplification.
- **NSE endpoints are unofficial** and can change shape without notice —
  an error banner in the UI is the signal to check the actual NSE network
  tab for a changed response shape.
- A stale "Cannot read properties of null (reading 'addEventListener')"
  console error can persist across reloads in a long-running preview
  browser tab even when the actual served file is fine — cross-check
  against the real file's line count / a genuine live-interaction test
  before treating it as a real regression.

## 11. Deployment (`render.yaml`)

```yaml
services:
  - type: web
    name: nifty-dashboard
    runtime: python
    plan: starter   # NOT free - see section 4 for why
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn backend.main:app --host 0.0.0.0 --port $PORT
    envVars:
      - key: NIFTY_DATA_DIR
        value: /var/data
      - key: FYERS_APP_ID
        sync: false   # set manually in Render's dashboard
      - key: FYERS_APP_SECRET
        sync: false
      - key: FYERS_REDIRECT_URI
        sync: false   # must exactly match the Redirect URL on the Fyers app itself
    disk:
      name: intraday-history
      mountPath: /var/data
      sizeGB: 1
```

Fyers is an **optional** real-time-quotes layer (OAuth login flow at
`/fyers/login` → `/fyers/callback`, token persisted to disk, expires
daily so re-login is needed once each trading morning) — the whole app
works without it, using NSE's own (slightly-lagged, cached) public data.
Only bother with this if the rebuild specifically needs broker-accurate
real-time prices for one table.

## 12. Verification approach

There's no automated test suite — this was built and verified through
live interaction: run locally (`uvicorn backend.main:app --reload --port
8420`), open a browser, click through every page/tab, check the browser
console for genuinely new errors (not stale artifacts), and cross-check
a couple of API responses directly (`curl localhost:8420/api/...`)
against what the UI shows. Scanners depending on self-tracked intraday
data can only be FULLY verified live during Indian market hours (09:15–
15:30 IST weekdays) — outside that window, the best you can confirm is
the "not ready / building" empty-state path.
