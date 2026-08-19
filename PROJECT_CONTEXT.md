# Nifty Sector Dashboard — Project Context / Handoff

Paste this into a new chat to resume work with full context. Written 2026-08-15,
updated 2026-08-16.

## What this is

A FastAPI backend + two vanilla-JS frontends tracking NSE's F&O (futures &
options) universe: sector heatmap, market breadth, movers, self-tracked
intraday scanners, and a full-universe F&O stock table. Two frontends
share one API for side-by-side comparison:
- `/` — the original/classic build (light theme) — has the self-tracked
  ORB/Buy-Sell/15-Min-Breakout scanners and the F&O Stock List screener
  (F&O Screener existed here too, removed 2026-08-16 - see below).
- `/pro` — a from-scratch redesign (2026-08-16, see below): a dark,
  sidebar-nav "F&O Stock Dashboard" built to match a reference screenshot
  the user supplied. Its centerpiece is a full-universe, searchable/
  sortable/paginated **F&O Scanner** table - genuinely more feature-rich
  than `/` in that one area. Also has its own "Scanners" sidebar page with
  the same ORB/Buy-Sell/15-Min-Breakout scanners as `/`, ported 1:1.

Repo: **https://github.com/Vishwanathp24/nifty-heatmap** (pushed, `main`
branch). Check `git log` for the current latest commit hash rather than
trusting a hash written into this doc - it goes stale immediately.

Local path: `/Users/vishwanathpujari/Documents/claude/nifty`

## Run it locally

```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8420
```
Open http://localhost:8420 (classic) or http://localhost:8420/pro (dark).
There's also `.claude/launch.json` configured for the Claude Code preview
tool (`preview_start` with `{name: "nifty-dashboard"}`).

## Architecture

- **`backend/nse_client.py`** (~1700 lines) — all data logic. NSE has no
  public API; this calls the same undocumented JSON endpoints
  nseindia.com's own pages use (session bootstrap via a cookie-setting
  page, then reused session, retry-with-rebootstrap on 401/403/5xx), plus
  NSE's daily "Bhavcopy" (EOD settlement) CSV archive, which — unlike the
  JSON APIs — is NOT behind bot protection, confirmed working directly.
  That Bhavcopy archive is the real daily-OHLC data source for everything
  that needs history (RSI/SMA/EMA/MACD/ADX, the Buy/Sell scanner's daily
  leg, the F&O Screener).
- **`backend/main.py`** — FastAPI routes, thin wrappers around
  `nse_client.client` methods. Serves both frontends as static files +
  index routes.
- **`frontend/`** — classic dashboard (index.html, app.js, styles.css).
- **`frontend_pro/`** — dark "pro" dashboard, same API, fewer panels.
- **`render.yaml`** — Render.com Blueprint for deployment (paid Starter
  plan + persistent disk — NOT free tier, see below for why).
- **`.gitignore`** — excludes the self-tracked JSON candle-history files,
  `__pycache__`, venvs, `.DS_Store`.

### Why some things are "self-tracked"

NSE has no accessible endpoint for historical intraday candles or
previous-day OHLC (tried several; all blocked or empty). So a background
thread (`_orb_loop`/`_orb_tick` in `NSEClient.__init__`) polls the F&O
universe every ~20s during market hours (09:15–15:30 IST, Mon–Fri) and
builds its own candles from those snapshots (`_bucket_candles`). Completed
candles are persisted to disk (`backend/intraday_history_{15,30,45,60}m.json`,
path overridable via `NIFTY_DATA_DIR` env var) so history survives restarts
and accumulates across trading days. This is why the app **cannot run on a
free-tier PaaS that spins down when idle** — it would silently lose its
tracking and never accumulate intraday history. Daily-level indicators
don't have this problem — they're built fresh from real Bhavcopy history
every few hours, no warm-up needed.

## Full feature list (classic frontend `/`)

1. **Sectoral Heatmap** — all 23 NSE sectoral indices, unfiltered, mirrors
   NSE's own site tile-for-tile (deliberately NOT deduped — user preferred
   this "first version" over a cleaner 13-sector consolidation that was
   tried and reverted). Click a tile → constituent stocks with TradingView
   chart links.
2. **Market Bias** — same-session breadth summary (Nifty 50, India VIX,
   advance/decline, F&O breadth, sector breadth) → Bullish/Bearish/Neutral
   score. Explicitly labeled "not a prediction". Sensex/global indices
   deliberately excluded (no reliable free source found).
3. **Nifty 50 Advance vs Decline** — vs today's **open** (not previous
   close, which is what NSE's own counters use).
4. **F&O Gainers / Losers**, **Most Active Equities** (by Volume/Value,
   side by side), **Volume Gainers**, **52-Week High/Low** (Highs/Lows side
   by side) — all F&O-universe-filtered, sortable, sector-filterable via
   one shared dropdown.
5. **Scanners panel** — one tabbed panel (mobile-friendly: only one
   sub-section renders at a time) containing:
   - **Opening Range Breakout (ORB)** — 5/15/30/45/60-min windows,
     self-tracked. Only shows stocks that actually broke the range.
   - **Buy/Sell Scanner (Bullish/Bearish Intraday)** — daily (real,
     Bhavcopy-backed) + selectable intraday timeframe (self-tracked):
     Close vs SMA(20), Close vs each of last 5 bars' High/Low, RSI(14) vs
     60/40. Replicated from 2 published Chartink screenshots. A stock only
     "qualifies" once both timeframes pass.
   - **15-Min Breakout Scanner** — independent, pure 15-min: Close vs
     rolling 20-bar Close-high, Volume vs its own 20-bar SMA. Note: the
     Sell variant deliberately wants volume BELOW average (not a spike) —
     that's the source scanner's own asymmetric rule, kept as-is.
6. **F&O Stock List (Volume & RSI)** — liquidity/valuation screener
   (Market Cap > ₹30,000 Cr, Mkt Cap/Turnover < 3000, Turnover >
   ₹50 Cr, Up-from-52w-low < 200%). Collapsed by default, shows only
   qualifying stocks. One condition (ROCE vs 3yr avg) intentionally NOT
   applied — no accessible NSE data source for financial-statement ratios.

## `/pro` — full redesign to match a reference screenshot (2026-08-16)

The user supplied a screenshot of a "NSE F&O Stock Dashboard" mockup
(sidebar nav, top index strip, a big searchable/sortable/paginated F&O
table with quick filters, summary cards, bottom mini-panels) and asked for
`/pro` to become that. Confirmed scope up front (3 scoping questions, all
recommended options chosen):
1. **Full sidebar redesign**, not just adding the table to the old layout.
2. **No Open Interest column** — OI isn't fetched anywhere in this app and
   NSE has no confirmed-accessible OI endpoint; adding it needs real
   investigation first, not a placeholder. If OI is ever wanted, treat it
   as new work — don't assume it's a trivial add.
3. **Only the F&O Scanner page fully built** for this pass; the other 8
   sidebar destinations either reuse existing data as their own view or
   are explicit "coming soon" stubs (Watchlist, Settings — both need new
   functionality, persistence and config respectively, that doesn't exist).

**New backend**: `NSEClient.get_fo_scanner_list()` in `nse_client.py` —
the full F&O universe (~208 symbols) in one call, real data only, straight
from `_fo_quote_rows()` (no self-tracking): symbol, sector, ltp, pChange,
change (₹), volume, valueCr (turnover), prevClose, yearHigh, yearLow,
dayHigh, dayLow, marketCapCr (free-float, reuses the same `ffmc` field
`get_fo_stock_list` already relies on), plus two derived flags -
`highVolume` (symbol is in NSE's own Volume Gainers list, reusing
`_volume_spurts()` rather than inventing a percentile) and `breakout`
(LTP at/above the day's high AND up on the day - a simple proxy since
`/pro` has no ORB/intraday-breakout tracking). Route: `GET /api/fo-scanner`.

**`/pro` sidebar** (`frontend_pro/`, completely rewritten - `index.html`,
`styles.css`, `app.js` are all new): Dashboard, **F&O Scanner** (default/
landing view - matches what the reference screenshot showed), Market
Breadth, Sector Heatmap, Top Movers, 52-Week High/Low, Volume Shockers,
Watchlist (stub), Settings (stub), plus a Classic-view link and a
dark/light theme toggle (persisted via `localStorage`). Top strip: NIFTY
50 / BANK NIFTY / INDIA VIX (from `/api/market-overview`) + Adv/Dec (from
`/api/advance-decline`) + a client-side ticking clock (IST).

**F&O Scanner page**: quick-filter chips (All/Breakout/Price Up/Price
Down/High Volume/52W High/52W Low - the last two computed client-side
from `yearHigh`/`yearLow`, within 1% counted as "at" the level), a filter
row (Segment/Exchange are fixed single-option dropdowns - this app only
ever covers NSE F&O; Market Cap uses `marketCapCr` bands **₹20,000 Cr /
₹5,000 Cr** cutoffs - a documented approximation, not SEBI's rank-based
large/mid/small definition; Sector from `/api/sector-labels`; Price
range) with Apply/Reset, 5 summary cards (Total/Advancers/Decliners/
Unchanged/Total Volume - always computed from the full unfiltered
universe, not the current filtered view), then the table itself: live
search, per-column sort, a Columns show/hide dropdown, CSV export (client-
side Blob download - this is the user's own locally-run app, not a
published Artifact, so a plain `<a download>` is fine here), and
client-side pagination (10/25/50/100/All rows per page). Below the table:
Top Gainers / Top Losers / High Volume mini-lists and a compact Sectors
Heatmap grid, all derived from the same `/api/fo-scanner` response (no
extra requests).

**Other sidebar pages** just reuse existing endpoints
(`/api/heatmap`+drawer via `/api/sector`, `/api/advance-decline`,
`/api/fo/gainers-losers`, `/api/most-active`, `/api/52-week`,
`/api/volume-gainers`) rendered into their own dedicated view instead of
being stacked cards on one page.

**Incidentally fixed a pre-existing bug**: the OLD `/pro` app.js called a
`/api/fo/volume` endpoint that doesn't exist in `main.py` (never did, as
far as this history shows) - meaning the old Volume Leaders/Volume Spurts
panels silently 404'd on every refresh. The rewrite calls the real
`/api/most-active` and `/api/volume-gainers` routes instead.

**Verified live** (preview browser, not just code review): every sidebar
page switches and renders real data; search/sort/quick-filters/Apply-
Reset/Columns-toggle/CSV-export all functionally tested via `javascript_exec`
(not just visually) - e.g. "Price Up" quick filter returned exactly the
same count as the Advancers summary card; the drawer opens real
constituent-stock data for a clicked sector tile; dark/light theme toggle
and mobile layout (sidebar collapses behind a burger button) both checked;
`/` (classic) confirmed completely unaffected.

**Follow-up refinements in the same batch** (all also verified live, all
committed together):
- Added a **"Scanners"** sidebar page — Opening Range Breakout, Buy/Sell
  (Bullish/Bearish), 15-Min Breakout, ported 1:1 from the classic
  dashboard (same routes, same rules, same auto-sync-direction-to-bias
  behavior). Watch for ID/name collisions if extending this further -
  porting classic's code here once already caused a real bug (`SCANNER_
  COLUMNS`/`refreshScanner`/`#scanner-table` collided with the F&O
  Scanner page's own identically-named things and would have thrown a
  duplicate-`const` SyntaxError); the Buy/Sell scanner's identifiers are
  now prefixed `BUYSELL_`/`buysell-*` specifically to avoid this.
- Top index strip now includes a **Market Bias** card (label only -
  "Bearish"/"Bullish"/"Neutral / Mixed", no score/count/action-hint text
  alongside it - both were tried and explicitly reverted per user
  feedback: a raw signed score like "-3 / 5" read as confusing, and a
  derived "Buy Call"/"Buy Put" action hint was explicitly not wanted
  either, "just market bias Bearish or bullish that is enough").
- Dark/light theme toggle moved from the sidebar footer into the topbar
  (next to Auto Refresh) as a plain single-click icon button (🌙/☀️, no
  switch/slider) - explicitly requested to match the classic dashboard's
  simpler toggle pattern and for easier mobile reach without opening the
  sidebar.
- Full Sector Heatmap page's tiles recolored to solid green/red-tinted
  cards (matching the mini Sectors Heatmap panel's style) instead of dark
  cards with just a bottom accent bar - explicit user request, screenshot-
  driven.
- Mini Sectors Heatmap panel (on the F&O Scanner page) now shows the
  actual top 6 AND bottom 6 sectors by % change (previously just the
  first 12 in descending order, which silently hid the real worst
  decliners on a broadly red day) and its tiles are now clickable,
  opening the same constituent-stock drawer as the full Heatmap page.
- Added a **view-switch link both ways**, positioned beside the dark-mode
  toggle on each: `/`'s header has a "Pro view" button right next to its
  🌙/☀️ toggle; `/pro`'s topbar has a "Classic view" button right next to
  its own toggle (moved there from the sidebar footer, which no longer
  exists - it only ever held that one link).

Committed and pushed to `main` - see Git/GitHub state below for the commit hash.

## F&O Screener — built, then removed (2026-08-15)

A 4th Scanners-panel tab, "Screener": 5 daily-technical screens replicated
from published Chartink scanners (Bullish Trend (MA+ADX+MACD), Open=High/
Low, Strong Uptrend, Volume Shockers, F&O Stocks price-range), each showing
per-stock condition chips, running on real Bhavcopy daily history (no
self-tracking). The user asked to remove it. Fully reverted: the tab/
group-div/JS (`loadScreenerList`/`refreshScreener`/`renderChecks`/
`escapeAttr`/`SCREENER_COLUMNS`)/CSS (`.check-chip`/`.checks-cell`) in the
classic dashboard, the `/api/screener*` routes in `main.py`, and every
`SCREENER_*` constant + the 5 `_screen_*` functions + the screener-only
`_wma`/`_macd`/`_adx` math + `get_screener_list`/`get_screener_status`/
`get_screener` in `nse_client.py` — all gone, confirmed via grep sweep and
a live check that `/api/screener*` now 404s while the Buy/Sell scanner
(the only other consumer of `_get_daily_history`) still works.
`DAILY_HISTORY_TARGET_DAYS` was reverted **65 → 30** (30 was the original,
pre-Screener value — the Buy/Sell scanner's daily leg only needs ~21 days;
65 existed solely so the Screener's SMA(50)/MACD/ADX had warm-up room).
The "6 more published Chartink screens" deferred-work item below is now
moot (there is no Screener left to extend) but left in place as history.
No reason was given for the removal - if this comes up again, don't
assume it's unwanted for the same reason as before; ask fresh, same as
the Intraday Option Signal removal below.

## Intraday Option Signal — built, then removed (2026-08-15)

A simplified intraday option-buying decision tool (Market Bias + 15-Min
ORB + 5/9 EMA + Volume + RSI → BUY CALL/BUY PUT/NO TRADE) was built here
across several phases in one session (single-symbol lookup in the classic
dashboard, a dedicated `/signal` site with a whole-F&O-universe Bullish/
Bearish scan, then a candle-close-confirmed ORB + false-breakout filter +
computed Entry/Stop-Loss/Target + static option-selection guidance) — then
the user asked to remove it entirely in the same session. Fully reverted:
the `/signal` route, `frontend_signal/` directory, all `/api/option-signal*`
+ `/api/fo-symbols` routes, every `OPTION_SIGNAL_*`/`_option_signal_*`
piece in `nse_client.py`, and the tab/JS/CSS in the classic dashboard are
all gone — verified via a full grep sweep (no leftover references) and a
live check that `/signal` and the removed API routes now 404 while
everything else (`/`, `/pro`, the 4 remaining scanner tabs) still works.
No reason was given for the removal - if this comes up again, don't assume
it's unwanted for the same reason as before; ask fresh.

## Fyers real-time quotes integration (2026-08-19) — Phase 1 done, Phase 2 pending

The user compared this dashboard's live prices against their broker and
found a mismatch. Root cause explained: this app sources data from NSE's
own public website JSON endpoints (not a licensed real-time feed) plus
several caching layers (15s/8s backend TTLs + 20s frontend poll), while
brokers use a licensed real-time exchange feed - a persistent, structural
gap, not a bug. User chose to integrate their own broker's real-time API
to close it, scoped to **F&O Scanner table only** (everything else stays
on NSE data - the Bhavcopy-based daily scanners are already reliable and
unaffected either way).

Compared Upstox/Fyers/Dhan on cost (not accuracy - all three use licensed
exchange feeds, no meaningful accuracy difference): Dhan's *market data*
API needs a paid ₹499/mo add-on (only order-placement is free); Upstox's
free tier is explicitly time-limited ("valid till 30 Sept 2026"); **Fyers**
is free with no stated expiry - user went with Fyers, created an app named
"NSE F&O Dashboard" (non-trading, permissions: Quotes/market data +
Historical data, NOT order placement) with Redirect URL
`https://heatmap.bankerage.in/fyers/callback`.

**Built (`backend/fyers_client.py`, routes in `main.py`)**: the full OAuth
login flow via the official `fyers-apiv3` SDK (`fyersModel.SessionModel`/
`FyersModel` - verified against the actual installed package source, not
just docs, since Fyers' public docs don't reliably expose exact method
signatures) -
- `GET /fyers/login` - redirects to Fyers' own login page
- `GET /fyers/callback` - exchanges the auth `code` for an access token,
  persists it to `{DATA_DIR}/fyers_token.json` with the IST issue-date
- `GET /api/fyers/status` - `{"connected": bool}`, used by the frontend
- `GET /api/fyers/raw-quote?symbols=RELIANCE,TCS` - diagnostic passthrough

Access tokens expire daily (Fyers invalidates them overnight) - tracked
here as "valid only for the calendar day (IST) it was issued", so the user
re-logs in via `/fyers/login` once each trading morning. Requires env vars
`FYERS_APP_ID`/`FYERS_APP_SECRET`/`FYERS_REDIRECT_URI` (documented as
`sync: false` placeholders in `render.yaml` - real values live only in
Render's dashboard and the user's local `.env`, never in the repo or this
chat). Login flow verified end-to-end locally with fake credentials
(confirmed it redirects to the real `api-t1.fyers.in` auth endpoint with
correct params) - not yet verified with the user's real account.

**Deliberately NOT done yet - Phase 2**: parsing Fyers' Quotes response
into the F&O Scanner table. Why held back: Fyers' docs don't publish exact
response field names anywhere fetchable, AND there are user-reported cases
(Fyers community forum) of the Quotes API returning a **null LTP
specifically for NSE F&O-list symbols, even during market hours** - a
real, documented risk matching this exact use case, not hypothetical.
Guessing field names and shipping wrong numbers would be worse than the
NSE-lag problem being solved. Next step: user completes `/fyers/login`,
then use `/api/fyers/raw-quote` together to inspect one real response,
confirm field names (and whether the null-LTP issue actually bites for
this app's symbol list) before writing the parsing/mapping into
`get_fo_scanner_list`. Do not skip this verification step even if asked
to "just wire it in" - the risk is specifically about this API+symbol-type
combination, confirmed via web search, not a generic caution.

## NOT yet built (explicitly deferred, not forgotten)

- ~~6 more published Chartink screens~~ — **moot**: these would have
  extended the F&O Screener tab, which has since been removed entirely
  (see above). Left here only as a record of what was once being
  considered: "BUY 100% ACCURACY - MORNING SCANNER", "UP TREND F&O
  STOCKS", "DOWN TREND F&O STOCKS", "F&O - MONTHLY GAINERS & LOSERS",
  "MONTHLY LOWEST LOW F&O STOCKS", "TRENDLINE BREAKOUT F&O".
- **ROCE condition** in F&O Stock List — no accessible data source.
- **Actual deployment** — only *prepped* (render.yaml, `NIFTY_DATA_DIR` env
  var support), never actually deployed to Render.com or a VPS. User's
  goal was "have the data on the go" (mobile/remote access); recommended
  path is Render.com paid Starter plan + persistent disk (free tier would
  silently kill the self-tracking thread when idle), or a small always-on
  VPS (~$5-6/mo). Neither has been executed yet.
- `/pro` dark frontend intentionally does NOT have ORB/Buy-Sell/Breakout/
  Screener/F&O-Stock-List — scoped to the classic frontend only, by
  explicit earlier decision.

## Known technical gotchas worth remembering

- **Browser caching**: FastAPI's default static/file responses don't set
  `Cache-Control`, so Chrome can skip revalidation. Fixed via a global
  `no-cache` middleware in `main.py` — if frontend edits ever seem not to
  take effect, check for *duplicate stale uvicorn processes* first
  (`pkill -f "uvicorn backend.main:app"` then restart clean), that's bitten
  us before.
- **CSS Grid `1fr` overflow bug**: hit this twice — bare `1fr` grid tracks
  don't clamp below their content's min-content width. Both the heatmap
  grid and the paired F&O-panel rows (Gainers/Losers, Most Active,
  52-Week) drifted wider than the rest of the page until fixed with
  `minmax(0, 1fr)` (+ `min-width: 0` on the grid item, needed when the
  overflow is nested a level deeper). Watch for this pattern if new
  side-by-side panels get added.
- **NSE endpoints are unofficial** — can change shape without notice. An
  error banner in the UI is the signal to check `nse_client.py` against
  NSE's own network tab.
- **RSI** implementation is a simplified trailing-window average (not full
  Wilder smoothing from inception) — standard simplification, documented
  in the code.
- Git identity for this repo is set **locally** (not global):
  `Vishwanath <vishwanath@radix.email>` — change via `git config
  user.name`/`user.email` if you want different commit attribution.

## Git/GitHub state

- Repo initialized, remote `origin` → `https://github.com/Vishwanathp24/nifty-heatmap.git`
  (HTTPS, not SSH — pushes need a GitHub Personal Access Token as the
  password when prompted, which is already cached/working on this
  machine as of the last successful push).
- 2 commits on `main` so far:
  1. `5aebd88` — Initial commit
  2. `dd35967` — Mobile-friendly Scanners panel, new F&O Screener tab,
     layout fixes
- Working tree was clean as of the last push (2026-08-15).

## Style/workflow notes for continuing this project

- The user has iteratively refined nearly every feature through direct,
  specific feedback (e.g. reverted a sector-consolidation redesign back to
  the "first version" because it "gives more clarity"). Prefer asking a
  scoping question (via a multiple-choice-style check-in) before large
  build-outs rather than assuming scope, especially when a feature request
  references external screenshots/specs with many conditions.
- When replicating a published scanner/screener, preserve its rules
  exactly (including quirky/asymmetric ones) rather than "fixing" them —
  this has come up multiple times and the user explicitly wants fidelity
  to the source, with any deviation clearly noted in the UI/code comments.
- Always verify UI changes live (this session uses the Claude Code
  preview/browser tools against `localhost:8420`) before declaring done —
  caching and stale-server bugs have caused false "it's broken" reports
  before.
- Never handle credentials/tokens/passwords directly — the user
  authenticates and pastes tokens into their own terminal prompts.
